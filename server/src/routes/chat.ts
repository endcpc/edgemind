/**
 * Chat / run endpoints.
 *   POST /api/chat                       new message | regenerate | edit-and-branch | continue/resume (SSE or 202 background)
 *   GET  /api/runs/:id                   run state + pending approvals
 *   GET  /api/runs/:id/events?after=N    step log polling (background mode / reconnect)
 *   POST /api/runs/:id/stop
 *   POST /api/runs/:id/approvals         { toolCallId, decision: allow_once | allow_conversation | deny }
 *   GET  /api/conversations/:id/messages full message tree + active leaf
 *   POST /api/internal/runs/:id/drive    HMAC-signed background driver (Netlify background fn / CF waitUntil chain)
 */
import type { Hono } from "hono";
import { and, asc, desc, eq, gt, inArray, ne, sql } from "drizzle-orm";
import type { AgentEvent, ApprovalDecision, ClientToolResult, Part, RunStatus } from "../../../shared/src/index";
import { CODE_OUTPUT_CAP, TERMINAL_RUN_STATUSES } from "../../../shared/src/index";
import type { AppDeps, Ctx, HonoEnv } from "../context";
import { runInBackground } from "../context";
import { auditLogs, conversations, files as files_, messages, models, projects, providers, runSteps, runs, settings, toolApprovals } from "../db/schema";
import { BadInput } from "../lib/errors";
import { hmacHex, timingSafeEqual } from "../lib/crypto";
import { aiBinding } from "./kb";
import { abortLocalRun, closeStoppedRun, driveRun, pendingApprovals, runSegment, type AgentEnv } from "../agent/loop";
import { appendStep, getRun, insertMessage, STALE_LEASE_MS, toMessageDTO, transition, type Checkpoint, type RunOptions, type RunPartial } from "../agent/store";
import { builtinRegistry } from "../agent/tools";
import { extractMemories } from "../memory";
import { fileStore } from "./files";
import { ensureBuiltinSkills } from "../skills/builtin";
import { SkillStore } from "../skills/store";
import { isPermissionMode } from "../agent/permissions";
import { usableModelId } from "../llm";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUuid = (v: unknown): v is string => typeof v === "string" && UUID.test(v);

export const DEFAULT_MAX_STEPS = 25;
/** One SSE tap stays open this long: it must close well before the platform's streaming cap (Netlify: 60 s). */
const STREAM_TAP_MS = 45_000;
/** How often the tap re-reads the step log + live partial. */
const STREAM_TAP_POLL_MS = 500;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const DEFAULT_SEGMENT = { softMs: 120_000 };
const DEFAULT_BACKGROUND = { softMs: 13 * 60_000, hardMs: 14 * 60_000 + 30_000 };
const MAX_INLINE_BYTES = 15 * 1024 * 1024;

export const driveToken = (secret: string, runId: string) => hmacHex(secret, `drive:${runId}`);

function parseContent(v: unknown): Part[] {
  if (typeof v === "string") {
    if (!v.trim()) throw new BadInput("訊息不可為空");
    return [{ type: "text", text: v }];
  }
  if (!Array.isArray(v) || !v.length || v.length > 50) throw new BadInput("content 必須是字串或 1–50 個 parts");
  let bytes = 0;
  const parts = v.map((p: any): Part => {
    if (p?.type === "text" && typeof p.text === "string") return { type: "text", text: p.text };
    if (p?.type === "image" && typeof p.mime === "string" && /^image\//.test(p.mime) && (typeof p.data === "string" || typeof p.url === "string")) {
      bytes += p.data?.length ?? 0;
      return { type: "image", mime: p.mime, ...(p.data ? { data: p.data } : { url: String(p.url) }) };
    }
    if (p?.type === "file" && typeof p.name === "string" && typeof p.mime === "string") {
      bytes += (p.data?.length ?? 0) + (p.text?.length ?? 0);
      return {
        type: "file", name: p.name.slice(0, 300), mime: p.mime,
        ...(isUuid(p.fileId) ? { fileId: p.fileId } : {}),
        ...(typeof p.data === "string" ? { data: p.data } : {}),
        ...(typeof p.text === "string" ? { text: p.text } : {}),
      };
    }
    throw new BadInput("不支援的訊息內容類型");
  });
  if (bytes > MAX_INLINE_BYTES) throw new BadInput("附件過大，請改用檔案上傳");
  if (!parts.some((p) => (p.type === "text" ? p.text.trim() : true))) throw new BadInput("訊息不可為空");
  return parts;
}

function parseOptions(v: any): RunOptions | undefined {
  if (!v || typeof v !== "object") return undefined;
  const o: RunOptions = {};
  if (v.reasoning && typeof v.reasoning === "object") {
    const effort = ["minimal", "low", "medium", "high"].includes(v.reasoning.effort) ? v.reasoning.effort : undefined;
    const budget = Number.isInteger(v.reasoning.budgetTokens) && v.reasoning.budgetTokens > 0 ? v.reasoning.budgetTokens : undefined;
    o.reasoning = { ...(effort ? { effort } : {}), ...(budget ? { budgetTokens: budget } : {}) };
  }
  if (Number.isInteger(v.maxTokens) && v.maxTokens > 0 && v.maxTokens <= 1_000_000) o.maxTokens = v.maxTokens;
  if (typeof v.temperature === "number" && v.temperature >= 0 && v.temperature <= 2) o.temperature = v.temperature;
  return o;
}

/** SSE response driven by `work(emit)`; the work keeps running (waitUntil) even if the client disconnects. */
function sse(c: Ctx, work: (emit: (e: AgentEvent, id?: number) => void, isClosed: () => boolean) => Promise<unknown>): Response {
  const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
  const writer = writable.getWriter();
  const enc = new TextEncoder();
  let closed = false;
  const write = (s: string) => {
    if (closed) return;
    writer.write(enc.encode(s)).catch(() => {
      closed = true;
    });
  };
  const emit = (e: AgentEvent, id?: number) => write(`${id !== undefined ? `id: ${id}\n` : ""}event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`);
  const ka = setInterval(() => write(": keep-alive\n\n"), 15_000);
  const p = (async () => {
    try {
      await work(emit, () => closed);
    } catch (e) {
      emit({ type: "error", error: { message: (e as Error).message, code: "internal" } });
    } finally {
      clearInterval(ka);
      closed = true;
      await writer.close().catch(() => {});
    }
  })();
  runInBackground(c, p);
  return new Response(readable, {
    headers: { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-cache, no-transform", "x-accel-buffering": "no" },
  });
}

/**
 * Whether anything is still executing a run. `stale`: running / pending / stopping but its lease expired (the segment
 * died, e.g. a platform time limit or a dropped connection). `resumable`: a stream-mode run that only moves on when a
 * page POSTs `continue` (paused between segments, or stale) — the UI must offer that instead of waiting forever.
 */
export function runLiveness(
  run: { status: string; mode: string; updatedAt: Date; rescueCount?: number },
  now = Date.now(),
): { stale: boolean; resumable: boolean } {
  const stale = ["running", "pending", "stopping"].includes(run.status) && now - run.updatedAt.getTime() > STALE_LEASE_MS;
  const resumable = run.mode === "stream"
    ? run.status === "paused" || (stale && run.status !== "stopping")
    // A background run nobody is executing after the supervisor's restarts: the page offers 繼續執行 instead of spinning.
    : backgroundOrphaned(run, now) && (run.rescueCount ?? 0) >= MAX_BACKGROUND_RESCUES;
  return { stale, resumable };
}

/** A paused/pending background run should be picked up by the next background invocation within seconds. */
export const BACKGROUND_IDLE_MS = 20_000;
/** Automatic restarts of an orphaned background run before the page shows 繼續執行. */
export const MAX_BACKGROUND_RESCUES = 3;
/** Minimum time between two automatic restarts of the same run. */
const RESCUE_INTERVAL_MS = 60_000;
/** A browser-side tool (code_run python) nobody picked up in this long is skipped so the run never waits forever. */
const CLIENT_TOOL_TTL_MS = 180_000;

/**
 * No background function is executing this background run: its lease went stale (the function died, hit its time limit
 * or crashed), or it stayed paused/pending (the chained invocation was never started, or the page that should have
 * started it went away).
 */
export function backgroundOrphaned(run: { status: string; mode: string; updatedAt: Date }, now = Date.now()): boolean {
  if (run.mode !== "background") return false;
  const idle = now - run.updatedAt.getTime();
  if (run.status === "running") return idle > STALE_LEASE_MS;
  if (run.status === "paused" || run.status === "pending") return idle > BACKGROUND_IDLE_MS;
  return false;
}

async function lastSeq(c: Ctx, runId: string): Promise<number> {
  const [r] = await c.get("database").db.select({ n: sql<number>`coalesce(max(${runSteps.seq}), 0)::int` }).from(runSteps).where(eq(runSteps.runId, runId));
  return Number(r?.n ?? 0);
}

const str = (v: unknown, max: number): string | undefined => (typeof v === "string" ? (v.length > max ? `${v.slice(0, max)}\n…[已截斷]` : v) : undefined);

/** Validate / cap what the browser reports (never trust its sizes). File ids must exist. */
async function sanitizeClientResult(c: Ctx, raw: any): Promise<ClientToolResult> {
  if (!raw || typeof raw !== "object") throw new BadInput("缺少 result");
  const cap = CODE_OUTPUT_CAP + 500;
  const fileList = (v: unknown) => (Array.isArray(v) ? v.slice(0, 100) : [])
    .filter((f: any) => f && typeof f.path === "string" && isUuid(f.fileId))
    .map((f: any) => ({ path: f.path.slice(0, 500), fileId: f.fileId as string, size: Number.isFinite(f.size) ? Number(f.size) : 0, ...(f.kind === "figure" ? { kind: "figure" as const } : {}) }));
  let files = fileList(raw.files);
  const full = raw.fullOutput && typeof raw.fullOutput.path === "string" && isUuid(raw.fullOutput.fileId) ? { path: raw.fullOutput.path.slice(0, 500), fileId: raw.fullOutput.fileId as string } : null;
  const ids = [...files.map((f) => f.fileId), ...(full ? [full.fileId] : [])];
  const known = ids.length ? new Set((await c.get("database").db.select({ id: files_.id }).from(files_).where(inArray(files_.id, ids))).map((r) => r.id)) : new Set<string>();
  files = files.filter((f) => known.has(f.fileId));
  return {
    ok: raw.ok === true,
    stdout: str(raw.stdout, cap) ?? "",
    stderr: str(raw.stderr, cap) ?? "",
    result: str(raw.result, cap) ?? null,
    error: str(raw.error, 10_000) ?? null,
    ...(Number.isFinite(raw.durationMs) ? { durationMs: Math.round(raw.durationMs) } : {}),
    ...(raw.stdoutTruncated ? { stdoutTruncated: true } : {}),
    ...(raw.stderrTruncated ? { stderrTruncated: true } : {}),
    ...(full && known.has(full.fileId) ? { fullOutput: full } : {}),
    ...(files.length ? { files } : {}),
    ...(Array.isArray(raw.notSaved) && raw.notSaved.length
      ? { notSaved: raw.notSaved.slice(0, 100).filter((n: any) => typeof n?.path === "string").map((n: any) => ({ path: n.path.slice(0, 500), reason: String(n.reason ?? "").slice(0, 300) })) }
      : {}),
  };
}

/** Helpers other routes (scheduler) use to start agent runs. */
export interface ChatApi {
  /** New conversation + user message + background run, started immediately. */
  startConversationRun(c: Ctx, args: { prompt: string; title: string; projectId: string | null; modelId: string | null; permissionMode: string | null }): Promise<{ runId: string; conversationId: string }>;
}

export function mountChat(app: Hono<HonoEnv>, deps: AppDeps): ChatApi {
  const registry = deps.tools ?? builtinRegistry();
  const segmentBudget = deps.platform?.segment ?? DEFAULT_SEGMENT;
  const backgroundBudget = deps.platform?.background ?? DEFAULT_BACKGROUND;
  /**
   * Segment options for a streamed request that started at `t0`: the platform's wall-clock cap counts from the request,
   * not from runSegment, so the time already spent here (auth, migrations, skills, settling runs, model lookup) comes off.
   */
  const segmentOpts = (t0: number) => ({
    ...segmentBudget,
    startedAt: t0,
    ...(deps.platform?.minStepMs !== undefined ? { minStepMs: deps.platform.minStepMs } : {}),
    ...(deps.platform?.backgroundOnDeadline ? { backgroundOnDeadline: true } : {}),
  });

  const agentEnv = (c: Ctx): AgentEnv => ({
    database: c.get("database"),
    encKey: c.get("encKey"),
    registry,
    fetch: deps.fetch,
    storage: fileStore(c, deps),
    ai: aiBinding(c),
    onCompleted: (runId) =>
      runInBackground(c, extractMemories(c.get("database"), c.get("encKey"), deps.fetch ?? ((...a) => fetch(...a)), runId).catch((e) => console.error("[edgemind] memory extraction failed", e))),
    ...deps.agent,
  });

  /** Kick off background execution of a run (platform-specific). */
  async function startBackground(c: Ctx, runId: string) {
    const origin = new URL(c.req.url).origin;
    const token = await driveToken(c.get("env").JWT_SECRET, runId);
    if (deps.platform?.startBackground) return deps.platform.startBackground({ origin, runId, token, c });
    // Default (Node / tests): in-process, chained until the run leaves `paused`.
    const env = agentEnv(c);
    runInBackground(
      c,
      (async () => {
        for (let i = 0; i < 1000; i++) {
          const o = await driveRun(env, runId, backgroundBudget);
          if (o.status !== "paused" || o.reason === "busy") return;
        }
      })(),
    );
  }

  /**
   * Called while a page watches a run (step-log polling, conversation load): restart an orphaned background run, at most
   * MAX_BACKGROUND_RESCUES times and once per RESCUE_INTERVAL_MS (atomic, so concurrent polls start one invocation).
   */
  async function superviseBackground(c: Ctx, run: { id: string; status: string; mode: string; updatedAt: Date }) {
    const database = c.get("database");
    // A background run may wait for a browser-side tool (code_run python). With the tab gone it would wait forever:
    // skip it after the TTL so the model gets an error and the run moves on.
    if (run.mode === "background" && run.status === "waiting_approval") {
      const expired = await database.query<{ id: string }>(
        `UPDATE tool_approvals SET status = 'denied', decided_at = now()
           WHERE run_id = $1 AND kind = 'client' AND status = 'pending'
             AND created_at < now() - ($2::int * interval '1 millisecond')
         RETURNING id`,
        [run.id, CLIENT_TOOL_TTL_MS],
      );
      if (expired.length) {
        console.warn(`[edgemind] ${expired.length} browser tool(s) of run ${run.id} timed out; skipping them`);
        if (await transition(database, run.id, ["waiting_approval"], { status: "paused" })) await startBackground(c, run.id);
      }
      return;
    }
    if (!backgroundOrphaned(run)) return;
    const rows = await database.query<{ rescue_count: number }>(
      `UPDATE runs SET rescue_count = rescue_count + 1, rescued_at = now()
         WHERE id = $1 AND mode = 'background' AND rescue_count < $2
           AND (rescued_at IS NULL OR rescued_at < now() - ($3::int * interval '1 millisecond'))
       RETURNING rescue_count`,
      [run.id, MAX_BACKGROUND_RESCUES, RESCUE_INTERVAL_MS],
    );
    if (!rows.length) return;
    console.warn(`[edgemind] background run ${run.id} orphaned (${run.status}); restart ${rows[0].rescue_count}/${MAX_BACKGROUND_RESCUES}`);
    await startBackground(c, run.id).catch((e) => console.error("[edgemind] background restart failed", e));
  }

  async function pickModel(c: Ctx, explicit: unknown, conv?: { modelId: string | null; projectId: string | null }): Promise<string> {
    const db = c.get("database").db;
    const database = c.get("database");
    if (explicit !== undefined && explicit !== null) {
      if (!isUuid(explicit)) throw new BadInput("modelId 格式錯誤");
      const m = await usableModelId(database, explicit);
      if (m) return m;
      // A page opened before the model was removed / disabled (or a stale global default it fell back to) still sends
      // the old id: use the next usable default instead of refusing the turn (and, for a new chat, the conversation).
    }
    // Saved references can point at a model that was removed or disabled since: skip those instead of failing the turn.
    const convModel = await usableModelId(database, conv?.modelId);
    if (convModel) return convModel;
    if (conv?.projectId) {
      const [p] = await db.select({ m: projects.defaultModelId }).from(projects).where(eq(projects.id, conv.projectId)).limit(1);
      const projModel = await usableModelId(database, p?.m);
      if (projModel) return projModel;
    }
    const [s] = await db.select().from(settings).where(eq(settings.key, "default_model_id")).limit(1);
    const globalModel = await usableModelId(database, s?.value);
    if (globalModel) return globalModel;
    const [first] = await db
      .select({ id: models.id })
      .from(models)
      .innerJoin(providers, eq(providers.id, models.providerId))
      .where(and(eq(providers.type, "llm"), eq(providers.enabled, true), eq(models.enabled, true)))
      .orderBy(asc(providers.priority), asc(models.modelId))
      .limit(1);
    if (!first) throw new BadInput("尚未設定任何語言模型，請先到設定新增供應商與模型");
    return first.id;
  }

  async function maxStepsSetting(c: Ctx, requested: unknown): Promise<number> {
    if (Number.isInteger(requested) && (requested as number) >= 1 && (requested as number) <= 200) return requested as number;
    const [s] = await c.get("database").db.select().from(settings).where(eq(settings.key, "max_steps")).limit(1);
    return Number.isInteger(s?.value) && (s!.value as number) >= 1 ? (s!.value as number) : DEFAULT_MAX_STEPS;
  }

  /** Close idle runs of a conversation before a new turn so the branch never ends on unanswered tool calls. */
  async function settleOpenRuns(c: Ctx, conversationId: string) {
    const database = c.get("database");
    const open = await database.db.select().from(runs).where(and(eq(runs.conversationId, conversationId), inArray(runs.status, ["pending", "paused", "waiting_approval", "running", "stopping"])));
    for (const r of open) {
      const stale = Date.now() - r.updatedAt.getTime() > STALE_LEASE_MS;
      // A run whose lease expired is dead (its function was killed): close it instead of blocking the next turn.
      if (!stale && (r.status === "running" || r.status === "stopping")) {
        return c.json({ error: "run_active", message: "這個對話還有執行中的任務，請先停止", runId: r.id }, 409);
      }
      if (await transition(database, r.id, [r.status as RunStatus], { status: "stopping" })) await closeStoppedRun(database, r);
    }
    return null;
  }

  app.post("/chat", async (c) => {
    const t0 = c.get("reqStart") ?? Date.now(); // the platform's wall-clock cap counts from the request
    const body = await c.req.json().catch(() => null);
    if (!body || typeof body !== "object") throw new BadInput("請求格式錯誤");
    const database = c.get("database");
    // Bundled skills (e2b-sandbox, self-hosted-runner) are installed on first use; memoized per isolate.
    await ensureBuiltinSkills(new SkillStore(database, fileStore(c, deps).s3));
    const db = database.db;

    // ----- continue / resume an existing run -----
    if (body.runId !== undefined) {
      if (!isUuid(body.runId)) throw new BadInput("runId 格式錯誤");
      const run = await getRun(database, body.runId);
      if (!run) return c.json({ error: "not_found", message: "找不到執行紀錄" }, 404);
      if (run.mode === "background") {
        // 繼續執行 (or the page's automatic resume): start a background invocation unless one is alive; fresh restarts.
        if (run.status === "paused" || run.status === "pending" || backgroundOrphaned(run)) {
          await database.query(`UPDATE runs SET rescue_count = 0, rescued_at = NULL WHERE id = $1`, [run.id]);
          await startBackground(c, run.id);
        }
        return c.json({ runId: run.id, conversationId: run.conversationId, status: run.status }, 202);
      }
      const env = agentEnv(c);
      return sse(c, (emit) => runSegment(env, run.id, { ...segmentOpts(t0), emit }));
    }

    // ----- new turn: new message, edit-and-branch, or regenerate -----
    // On platforms whose streaming cap is shorter than a long model step, never generate inside the request: the run is
    // handed to the background driver and the page watches GET /runs/:id/stream.
    const requested = body.mode === "background" ? "background" : "stream";
    const mode = requested === "stream" && deps.platform?.alwaysBackground ? "background" : requested;
    let conversationId: string;
    let conv: typeof conversations.$inferSelect | undefined;
    let newConvModel: string | undefined;
    if (body.conversationId !== undefined) {
      if (!isUuid(body.conversationId)) throw new BadInput("conversationId 格式錯誤");
      [conv] = await db.select().from(conversations).where(eq(conversations.id, body.conversationId)).limit(1);
      if (!conv) return c.json({ error: "not_found", message: "找不到對話" }, 404);
      conversationId = conv.id;
      const busy = await settleOpenRuns(c, conversationId);
      if (busy) return busy;
      [conv] = await db.select().from(conversations).where(eq(conversations.id, conversationId)).limit(1);
    } else {
      if (body.regenerate !== undefined) throw new BadInput("重新生成需要 conversationId");
      let projectId: string | null = null;
      if (body.projectId !== undefined && body.projectId !== null) {
        if (!isUuid(body.projectId)) throw new BadInput("projectId 格式錯誤");
        const [p] = await db.select({ id: projects.id }).from(projects).where(eq(projects.id, body.projectId)).limit(1);
        if (!p) throw new BadInput("找不到專案");
        projectId = p.id;
      }
      const firstText = typeof body.content === "string" ? body.content : Array.isArray(body.content) ? body.content.find((p: any) => p?.type === "text")?.text ?? "" : "";
      const permissionMode = body.permissionMode ?? null;
      if (permissionMode !== null && !isPermissionMode(permissionMode)) throw new BadInput("未知的權限模式");
      // Validate everything that can refuse the turn BEFORE the row exists: a failed first message must not leave an
      // empty conversation behind in the sidebar.
      parseContent(body.content);
      newConvModel = await pickModel(c, body.modelId, { modelId: null, projectId });
      [conv] = await db.insert(conversations).values({ projectId, permissionMode, title: String(firstText).trim().slice(0, 50) || "新對話" }).returning();
      conversationId = conv.id;
    }

    const modelId = newConvModel ?? (await pickModel(c, body.modelId, conv));
    let userMessageId: string;
    if (body.regenerate !== undefined) {
      if (!isUuid(body.regenerate)) throw new BadInput("regenerate 格式錯誤");
      const [m] = await db.select().from(messages).where(and(eq(messages.id, body.regenerate), eq(messages.conversationId, conversationId))).limit(1);
      if (!m || m.role !== "user") throw new BadInput("只能從使用者訊息重新生成");
      userMessageId = m.id;
      await db.update(conversations).set({ activeLeafId: m.id, updatedAt: new Date() }).where(eq(conversations.id, conversationId));
    } else {
      const parts = parseContent(body.content);
      let parentId: string | null = conv?.activeLeafId ?? null;
      if (body.parentId !== undefined) {
        // edit-and-branch: the new user message becomes a sibling of the edited one
        if (body.parentId === null) parentId = null;
        else {
          if (!isUuid(body.parentId)) throw new BadInput("parentId 格式錯誤");
          const [pm] = await db.select({ id: messages.id }).from(messages).where(and(eq(messages.id, body.parentId), eq(messages.conversationId, conversationId))).limit(1);
          if (!pm) throw new BadInput("找不到 parentId 指定的訊息");
          parentId = pm.id;
        }
      }
      const row = await insertMessage(database, { conversationId, parentId, role: "user", parts });
      userMessageId = row.id;
    }

    const checkpoint: Checkpoint = { leafId: userMessageId, options: parseOptions(body.options) };
    const [run] = await db
      .insert(runs)
      .values({ conversationId, userMessageId, status: "pending", mode, modelId, maxSteps: await maxStepsSetting(c, body.maxSteps), checkpoint })
      .returning();
    await db.update(messages).set({ runId: run.id }).where(and(eq(messages.id, userMessageId), eq(messages.role, "user")));

    if (mode === "background") {
      try {
        await startBackground(c, run.id);
      } catch (e) {
        // No background function on this platform / plan: run this turn as a streamed segment instead of stranding it.
        console.error("[edgemind] background start failed; falling back to a streamed segment", e);
        await db.update(runs).set({ mode: "stream" }).where(eq(runs.id, run.id));
        const env = agentEnv(c);
        return sse(c, (emit) => runSegment(env, run.id, { ...segmentOpts(t0), emit }));
      }
      return c.json({ runId: run.id, conversationId, userMessageId, status: "pending", mode: "background" }, 202);
    }
    const env = agentEnv(c);
    return sse(c, (emit) => runSegment(env, run.id, { ...segmentOpts(t0), emit }));
  });

  app.get("/runs/:id", async (c) => {
    const id = c.req.param("id");
    if (!isUuid(id)) return c.json({ error: "not_found" }, 404);
    const run = await getRun(c.get("database"), id);
    if (!run) return c.json({ error: "not_found", message: "找不到執行紀錄" }, 404);
    const cp = run.checkpoint as Checkpoint | null;
    return c.json({
      id: run.id, conversationId: run.conversationId, userMessageId: run.userMessageId, status: run.status, mode: run.mode,
      stepCount: run.stepCount, maxSteps: run.maxSteps, error: run.error, finishReason: cp?.finishReason ?? null,
      createdAt: run.createdAt.toISOString(), updatedAt: run.updatedAt.toISOString(), finishedAt: run.finishedAt?.toISOString() ?? null,
      ...runLiveness(run),
      approvals: await pendingApprovals(c.get("database"), run.id, registry),
    });
  });

  app.get("/runs/:id/events", async (c) => {
    const id = c.req.param("id");
    if (!isUuid(id)) return c.json({ error: "not_found" }, 404);
    const after = Math.max(0, Number(c.req.query("after") ?? 0) || 0);
    const run = await getRun(c.get("database"), id);
    if (!run) return c.json({ error: "not_found", message: "找不到執行紀錄" }, 404);
    const steps = await c.get("database").db.select().from(runSteps).where(and(eq(runSteps.runId, id), gt(runSteps.seq, after))).orderBy(asc(runSteps.seq)).limit(500);
    await superviseBackground(c, run).catch((e) => console.error("[edgemind] supervise failed", e));
    const nextAfter = steps.length ? steps[steps.length - 1].seq : after;
    // Live text of the background step being generated; stale (dropped) once a later step exists.
    const p = run.partial as RunPartial | null;
    const partial = run.mode === "background" && run.status === "running" && p && p.base >= nextAfter && steps.length < 500
      ? { text: p.text, reasoning: p.reasoning }
      : null;
    return c.json({
      status: run.status,
      mode: run.mode,
      ...runLiveness(run),
      stepCount: run.stepCount,
      steps: steps.map((s) => ({ seq: s.seq, kind: s.kind, payload: s.payload, createdAt: s.createdAt.toISOString() })),
      nextAfter,
      partial,
    });
  });

  /**
   * GET /runs/:id/stream?after=N — a disposable tap on a run's step log (SSE). It never generates anything: it reads
   * run_steps + runs.partial and closes after ~45 s, so it fits any platform's streaming cap. The page reconnects with
   * `after=<last id it saw>`; a step is therefore delivered exactly once per connection and never re-generated.
   */
  app.get("/runs/:id/stream", async (c) => {
    const id = c.req.param("id");
    if (!isUuid(id)) return c.json({ error: "not_found" }, 404);
    const after = Math.max(0, Number(c.req.query("after") ?? 0) || 0);
    const first = await getRun(c.get("database"), id);
    if (!first) return c.json({ error: "not_found", message: "找不到執行紀錄" }, 404);
    return sse(c, async (emit, isClosed) => {
      let run = first;
      let seq = after;
      emit({ type: "run", runId: id, conversationId: run.conversationId, userMessageId: run.userMessageId, status: run.status as RunStatus });
      const started = Date.now();
      let approvalsSent = false;
      let lastSupervise = 0;
      while (!isClosed() && Date.now() - started < STREAM_TAP_MS) {
        const fresh = await getRun(c.get("database"), id);
        if (fresh) run = fresh;
        // A background function that died is restarted here too: the tap is often the only thing watching the run.
        if (run.mode === "background" && backgroundOrphaned(run) && Date.now() - lastSupervise > 5_000) {
          lastSupervise = Date.now();
          await superviseBackground(c, run).catch((e) => console.error("[edgemind] supervise failed", e));
        }
        const rows = await c.get("database").db.select().from(runSteps)
          .where(and(eq(runSteps.runId, id), gt(runSteps.seq, seq))).orderBy(asc(runSteps.seq)).limit(200);
        for (const row of rows) {
          seq = row.seq;
          const pl = row.payload as any;
          if (row.kind === "message" && pl?.message) emit({ type: "message", message: pl.message }, row.seq);
          else if (row.kind === "tool_result") emit({ type: "tool-result", callId: pl?.callId, name: pl?.name, result: pl?.result, isError: pl?.isError }, row.seq);
          else if (row.kind === "error") emit({ type: "error", error: pl?.error ?? { message: String(pl?.message ?? "執行失敗"), code: "internal" } }, row.seq);
        }
        if (run.status === "running") {
          const p = run.partial as RunPartial | null;
          if (p && p.base >= seq && (p.text || p.reasoning)) emit({ type: "live", text: p.text, reasoning: p.reasoning });
        }
        if (run.status === "waiting_approval") {
          if (!approvalsSent) {
            approvalsSent = true;
            emit({ type: "approval-required", approvals: await pendingApprovals(c.get("database"), id, registry) });
          }
          emit({ type: "done", status: "waiting_approval" });
          return;
        }
        if (run.status === "paused" && run.mode !== "background") {
          // a streamed segment ended: the page decides whether to continue (202/stream fallback)
          emit({ type: "done", status: "paused", reason: "paused" });
          return;
        }
        if (runLiveness(run).resumable) {
          // nothing is executing it any more (restart limit reached): offer 繼續執行 instead of reconnecting forever
          emit({ type: "done", status: "paused", reason: "resumable" });
          return;
        }
        if (TERMINAL_RUN_STATUSES.includes(run.status as RunStatus)) {
          emit({ type: "done", status: run.status as RunStatus, reason: ((run.checkpoint as Checkpoint | null)?.finishReason) ?? undefined });
          return;
        }
        await sleep(STREAM_TAP_POLL_MS);
      }
    });
  });

  app.post("/runs/:id/stop", async (c) => {
    const id = c.req.param("id");
    if (!isUuid(id)) return c.json({ error: "not_found" }, 404);
    const database = c.get("database");
    const run = await getRun(database, id);
    if (!run) return c.json({ error: "not_found", message: "找不到執行紀錄" }, 404);
    const status = run.status as RunStatus;
    if (TERMINAL_RUN_STATUSES.includes(status)) return c.json({ status });
    await database.db.insert(auditLogs).values({ action: "run_stop", runId: id, conversationId: run.conversationId, detail: { from: status } });
    if (status === "pending" || status === "paused" || status === "waiting_approval") {
      if (await transition(database, id, [status], { status: "stopping" })) {
        await closeStoppedRun(database, run);
        return c.json({ status: "stopped" });
      }
    }
    if (status === "stopping" && Date.now() - run.updatedAt.getTime() > STALE_LEASE_MS) {
      await closeStoppedRun(database, run);
      return c.json({ status: "stopped" });
    }
    await transition(database, id, ["running"], { status: "stopping" });
    abortLocalRun(id);
    const fresh = await getRun(database, id);
    return c.json({ status: fresh?.status ?? "stopping" });
  });

  /** Record a decision (approval or ask_user answer) and resume the run when nothing else is pending. */
  async function decide(c: Ctx, id: string, toolCallId: unknown, kind: "approval" | "question" | "client", decision: ApprovalDecision, answer?: unknown) {
    if (typeof toolCallId !== "string") throw new BadInput("缺少 toolCallId");
    const database = c.get("database");
    const db = database.db;
    const run = await getRun(database, id);
    if (!run) return c.json({ error: "not_found", message: "找不到執行紀錄" }, 404);
    const kindFilter = kind === "client" ? eq(toolApprovals.kind, "client") : ne(toolApprovals.kind, "client");
    const [appr] = await db.select().from(toolApprovals).where(and(eq(toolApprovals.runId, id), eq(toolApprovals.toolCallId, toolCallId), kindFilter)).limit(1);
    if (!appr) return c.json({ error: "not_found", message: kind === "question" ? "找不到待回答的問題" : kind === "client" ? "找不到待執行的瀏覽器端工具" : "找不到待批准的工具呼叫" }, 404);
    if (appr.status !== "pending") return c.json({ error: "conflict", message: "此工具呼叫已經處理過" }, 409);
    if (appr.kind === "question" && kind === "approval" && decision !== "deny") throw new BadInput("這是提問，請用 /answers 回答（或拒絕以略過）");
    if (appr.kind !== "question" && kind === "question") throw new BadInput("這不是提問");
    if (kind !== "client" && appr.kind === "client") throw new BadInput("這是瀏覽器端工具，請用 /client-results 回傳結果");
    const status = decision === "deny" ? "denied" : "approved";
    const scope = decision === "allow_conversation" ? "conversation" : "once";
    await db.update(toolApprovals).set({ status, scope, decidedAt: new Date(), ...(answer !== undefined ? { answer } : {}) }).where(eq(toolApprovals.id, appr.id));
    if (decision === "allow_conversation") {
      // other pending calls of the same tool in this run are covered too
      await db.update(toolApprovals).set({ status: "approved", scope: "conversation", decidedAt: new Date() })
        .where(and(eq(toolApprovals.runId, id), eq(toolApprovals.toolName, appr.toolName), eq(toolApprovals.status, "pending"), eq(toolApprovals.kind, "approval")));
    }
    await db.insert(auditLogs).values({ action: appr.kind === "question" ? "ask_user_answer" : appr.kind === "client" ? "client_tool_result" : "tool_approval", runId: id, conversationId: run.conversationId, toolName: appr.toolName, decision: status, detail: { toolCallId: appr.toolCallId, scope } });
    await appendStep(database, id, "approval", { approvalId: appr.id, toolCallId: appr.toolCallId, toolName: appr.toolName, status, scope, kind: appr.kind });
    const remaining = await pendingApprovals(database, id, registry);
    let runStatus = run.status as RunStatus;
    if (!remaining.length && run.status === "waiting_approval") {
      if (await transition(database, id, ["waiting_approval"], { status: "paused" })) runStatus = "paused";
      if (runStatus === "paused" && run.mode === "background") await startBackground(c, id);
    }
    return c.json({ status: runStatus, remaining, resume: runStatus === "paused" && run.mode !== "background" });
  }

  app.post("/runs/:id/approvals", async (c) => {
    const id = c.req.param("id");
    if (!isUuid(id)) return c.json({ error: "not_found" }, 404);
    const body = await c.req.json().catch(() => null);
    const decision = body?.decision as ApprovalDecision;
    if (!["allow_once", "allow_conversation", "deny"].includes(decision)) throw new BadInput("decision 必須是 allow_once、allow_conversation 或 deny");
    return decide(c, id, body?.toolCallId, "approval", decision);
  });

  /** ask_user answers. */
  app.post("/runs/:id/answers", async (c) => {
    const id = c.req.param("id");
    if (!isUuid(id)) return c.json({ error: "not_found" }, 404);
    const body = await c.req.json().catch(() => null);
    if (typeof body?.answer !== "string" || !body.answer.trim()) throw new BadInput("請輸入回答");
    if (body.answer.length > 20_000) throw new BadInput("回答過長");
    return decide(c, id, body?.toolCallId, "question", "allow_once", body.answer.trim());
  });

  /** Result of a client-side tool (code_run python executed by the browser in Pyodide), or a cancel. */
  app.post("/runs/:id/client-results", async (c) => {
    const id = c.req.param("id");
    if (!isUuid(id)) return c.json({ error: "not_found" }, 404);
    const body = await c.req.json().catch(() => null);
    if (!body || typeof body !== "object") throw new BadInput("請求格式錯誤");
    if (body.cancel === true) return decide(c, id, body.toolCallId, "client", "deny");
    const result = await sanitizeClientResult(c, body.result);
    return decide(c, id, body.toolCallId, "client", "allow_once", result);
  });

  app.get("/conversations/:id/messages", async (c) => {
    const id = c.req.param("id");
    if (!isUuid(id)) return c.json({ error: "not_found" }, 404);
    const db = c.get("database").db;
    const [conv] = await db.select().from(conversations).where(eq(conversations.id, id)).limit(1);
    if (!conv) return c.json({ error: "not_found", message: "找不到對話" }, 404);
    const rows = await db.select().from(messages).where(eq(messages.conversationId, id)).orderBy(asc(messages.createdAt));
    // Latest unfinished run (reload while running / waiting for approval / paused between segments).
    const [open] = await db.select().from(runs)
      .where(and(eq(runs.conversationId, id), inArray(runs.status, ["pending", "running", "paused", "waiting_approval", "stopping"])))
      .orderBy(desc(runs.createdAt)).limit(1);
    const activeRun = open
      ? { id: open.id, status: open.status, mode: open.mode, ...runLiveness(open), approvals: await pendingApprovals(c.get("database"), open.id, registry), lastSeq: await lastSeq(c, open.id) }
      : null;
    return c.json({
      conversation: { id: conv.id, title: conv.title, projectId: conv.projectId, activeLeafId: conv.activeLeafId, permissionMode: conv.permissionMode, modelId: conv.modelId },
      messages: rows.map(toMessageDTO),
      activeRun,
    });
  });

  // ----- internal: background driver (HMAC-signed, exempt from cookie auth/CSRF) -----
  app.post("/internal/runs/:id/drive", async (c) => {
    const id = c.req.param("id");
    if (!isUuid(id)) return c.json({ error: "not_found" }, 404);
    const expected = await driveToken(c.get("env").JWT_SECRET, id);
    if (!timingSafeEqual(c.req.header("x-edgemind-drive") ?? "", expected)) return c.json({ error: "unauthorized" }, 401);
    const env = agentEnv(c);
    const work = async () => {
      const o = await driveRun(env, id, backgroundBudget);
      if (o.status === "paused" && o.reason !== "busy") await startBackground(c, id); // chain the next invocation
      return o;
    };
    if (deps.platform?.driveInline) return c.json(await work());
    runInBackground(c, work());
    return c.json({ accepted: true }, 202);
  });

  return {
    async startConversationRun(c, a) {
      const database = c.get("database");
      const db = database.db;
      await ensureBuiltinSkills(new SkillStore(database, fileStore(c, deps).s3));
      if (a.permissionMode !== null && !isPermissionMode(a.permissionMode)) throw new BadInput("未知的權限模式");
      const modelId = await pickModel(c, a.modelId ?? undefined, { modelId: null, projectId: a.projectId }); // model deleted → default
      const [conv] = await db.insert(conversations).values({ projectId: a.projectId, permissionMode: a.permissionMode, title: a.title.slice(0, 80) || "排程任務" }).returning();
      const msg = await insertMessage(database, { conversationId: conv.id, parentId: null, role: "user", parts: [{ type: "text", text: a.prompt }] });
      const [run] = await db.insert(runs).values({
        conversationId: conv.id, userMessageId: msg.id, status: "pending", mode: "background", modelId,
        permissionMode: a.permissionMode, maxSteps: await maxStepsSetting(c, undefined), checkpoint: { leafId: msg.id } satisfies Checkpoint,
      }).returning();
      await db.update(messages).set({ runId: run.id }).where(eq(messages.id, msg.id));
      await startBackground(c, run.id);
      return { runId: run.id, conversationId: conv.id };
    },
  };
}
