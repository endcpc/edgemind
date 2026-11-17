import type { Hono } from "hono";
import { and, asc, eq } from "drizzle-orm";
import { PROVIDER_TYPES, getKindSpec, type ProviderDTO, type ProviderInput } from "../../../shared/src/index";
import type { AppDeps, Ctx, HonoEnv } from "../context";
import { clientIp } from "../context";
import { auditLogs, models, providers } from "../db/schema";
import { decryptSecret, encryptSecret, maskSecret } from "../lib/crypto";
import { BadInput } from "../lib/errors";
import { listModels, testProvider, ProviderHttpError, type ProbeTarget } from "../providers/probe";

type Row = typeof providers.$inferSelect;

const aad = (id: string) => `provider:${id}:apiKey`;

function toDTO(r: Row): ProviderDTO {
  return {
    id: r.id,
    type: r.type as ProviderDTO["type"],
    kind: r.kind,
    name: r.name,
    baseUrl: r.baseUrl,
    apiKeyPreview: r.apiKeyPreview,
    hasApiKey: !!r.apiKeyEnc,
    enabled: r.enabled,
    priority: r.priority,
    config: r.config ?? {},
    createdAt: r.createdAt.toISOString(),
    updatedAt: r.updatedAt.toISOString(),
  };
}


function str(v: unknown, field: string, max = 500): string | undefined {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== "string") throw new BadInput(`${field} 必須是字串`);
  if (v.length > max) throw new BadInput(`${field} 過長`);
  return v.trim();
}

/** Validates create (full) or update (partial) input against the catalog. */
function parseInput(body: any, existing?: Row): ProviderInput {
  if (!body || typeof body !== "object") throw new BadInput("請求格式錯誤");
  const type = (existing?.type ?? body.type) as ProviderInput["type"];
  const kind = existing?.kind ?? body.kind;
  if (!PROVIDER_TYPES.includes(type)) throw new BadInput("未知的供應商類別");
  const spec = getKindSpec(type, kind);
  if (!spec) throw new BadInput(`不支援的供應商：${kind}`);
  const name = str(body.name, "名稱", 100);
  if (!existing && !name) throw new BadInput("請輸入名稱");
  const baseUrl = str(body.baseUrl, "Base URL", 500);
  if (baseUrl) {
    let u: URL;
    try {
      u = new URL(baseUrl);
    } catch {
      throw new BadInput("Base URL 格式錯誤");
    }
    if (u.protocol !== "https:" && u.protocol !== "http:") throw new BadInput("Base URL 必須是 http(s)");
  }
  const apiKey = str(body.apiKey, "API Key", 4000);
  let config: Record<string, string> | undefined;
  if (body.config !== undefined) {
    if (typeof body.config !== "object" || body.config === null || Array.isArray(body.config)) throw new BadInput("config 格式錯誤");
    const allowed = new Set((spec.configFields ?? []).map((f) => f.key));
    config = {};
    for (const [k, v] of Object.entries(body.config)) {
      if (!allowed.has(k)) continue;
      const s = str(v, k, 500);
      if (s) config[k] = s;
    }
  }
  let priority: number | undefined;
  if (body.priority !== undefined) {
    priority = Number(body.priority);
    if (!Number.isInteger(priority) || priority < 0 || priority > 100000) throw new BadInput("優先順序必須是 0–100000 的整數");
  }
  if (body.enabled !== undefined && typeof body.enabled !== "boolean") throw new BadInput("enabled 必須是布林值");
  if (!existing && !baseUrl && !spec.defaultBaseUrl) throw new BadInput("此供應商需要填寫 Base URL");
  return { type, kind, name: name ?? existing!.name, baseUrl, apiKey, enabled: body.enabled, priority, config };
}

async function loadTarget(c: Ctx, r: Row): Promise<ProbeTarget> {
  const apiKey = r.apiKeyEnc ? await decryptSecret(r.apiKeyEnc, c.get("encKey"), aad(r.id)) : null;
  return { type: r.type, kind: r.kind, baseUrl: r.baseUrl, apiKey, config: r.config ?? {} };
}

async function getRow(c: Ctx, id: string): Promise<Row | undefined> {
  if (!/^[0-9a-f-]{36}$/i.test(id)) return undefined;
  const [r] = await c.get("database").db.select().from(providers).where(eq(providers.id, id)).limit(1);
  return r;
}

export function mountProviders(app: Hono<HonoEnv>, deps: AppDeps) {
  const f = deps.fetch ?? ((...a: Parameters<typeof fetch>) => fetch(...a));

  const audit = (c: Ctx, action: string, detail: Record<string, unknown>) =>
    c.get("database").db.insert(auditLogs).values({ action, detail, ip: clientIp(c) });

  app.get("/providers", async (c) => {
    const type = c.req.query("type");
    const db = c.get("database").db;
    const rows = await db.select().from(providers)
      .where(type ? eq(providers.type, type) : undefined)
      .orderBy(asc(providers.type), asc(providers.priority), asc(providers.createdAt));
    return c.json(rows.map(toDTO));
  });

  app.post("/providers", async (c) => {
    const input = parseInput(await c.req.json().catch(() => null));
    const id = crypto.randomUUID();
    const encKey = c.get("encKey");
    const [row] = await c.get("database").db.insert(providers).values({
      id,
      type: input.type,
      kind: input.kind,
      name: input.name,
      baseUrl: input.baseUrl ?? getKindSpec(input.type, input.kind)!.defaultBaseUrl,
      apiKeyEnc: input.apiKey ? await encryptSecret(input.apiKey, encKey, aad(id)) : null,
      apiKeyPreview: input.apiKey ? maskSecret(input.apiKey) : null,
      enabled: input.enabled ?? true,
      priority: input.priority ?? 100,
      config: input.config ?? {},
    }).returning();
    await audit(c, "provider_create", { id, type: input.type, kind: input.kind });
    return c.json(toDTO(row), 201);
  });

  app.patch("/providers/:id", async (c) => {
    const existing = await getRow(c, c.req.param("id"));
    if (!existing) return c.json({ error: "not_found", message: "找不到供應商" }, 404);
    const input = parseInput(await c.req.json().catch(() => null), existing);
    const patch: Partial<typeof providers.$inferInsert> = { updatedAt: new Date(), name: input.name };
    if (input.baseUrl !== undefined) patch.baseUrl = input.baseUrl || getKindSpec(existing.type, existing.kind)!.defaultBaseUrl;
    if (input.enabled !== undefined) patch.enabled = input.enabled;
    if (input.priority !== undefined) patch.priority = input.priority;
    if (input.config !== undefined) patch.config = input.config;
    if (input.apiKey !== undefined) {
      patch.apiKeyEnc = input.apiKey ? await encryptSecret(input.apiKey, c.get("encKey"), aad(existing.id)) : null;
      patch.apiKeyPreview = input.apiKey ? maskSecret(input.apiKey) : null;
    }
    const [row] = await c.get("database").db.update(providers).set(patch).where(eq(providers.id, existing.id)).returning();
    await audit(c, "provider_update", { id: existing.id, keyChanged: input.apiKey !== undefined });
    return c.json(toDTO(row));
  });

  app.delete("/providers/:id", async (c) => {
    const existing = await getRow(c, c.req.param("id"));
    if (!existing) return c.json({ error: "not_found", message: "找不到供應商" }, 404);
    await c.get("database").db.delete(providers).where(eq(providers.id, existing.id));
    await audit(c, "provider_delete", { id: existing.id });
    return c.json({ ok: true });
  });

  /** Fetch the live model list from the provider. */
  app.get("/providers/:id/models/remote", async (c) => {
    const row = await getRow(c, c.req.param("id"));
    if (!row) return c.json({ error: "not_found", message: "找不到供應商" }, 404);
    try {
      return c.json({ models: await listModels(f, await loadTarget(c, row)) });
    } catch (e) {
      const msg = e instanceof ProviderHttpError ? e.message : (e as Error).message;
      return c.json({ error: "upstream_error", message: msg }, 502);
    }
  });

  /** Test a saved provider. Body: { model? } */
  app.post("/providers/:id/test", async (c) => {
    const row = await getRow(c, c.req.param("id"));
    if (!row) return c.json({ error: "not_found", message: "找不到供應商" }, 404);
    const body = await c.req.json().catch(() => ({}));
    const model = typeof body?.model === "string" ? body.model : undefined;
    return c.json(await testProvider(f, await loadTarget(c, row), { model }));
  });

  /** Test an unsaved draft (form "測試連線" before saving). Uses the stored key when `id` is given and apiKey omitted. */
  app.post("/providers/test", async (c) => {
    const body = await c.req.json().catch(() => null);
    const existing = typeof body?.id === "string" ? await getRow(c, body.id) : undefined;
    const input = parseInput(existing ? { ...body } : body, existing);
    const spec = getKindSpec(input.type, input.kind)!;
    let apiKey = input.apiKey ?? null;
    if (input.apiKey === undefined && existing?.apiKeyEnc) apiKey = await decryptSecret(existing.apiKeyEnc, c.get("encKey"), aad(existing.id));
    const target: ProbeTarget = {
      type: input.type,
      kind: input.kind,
      baseUrl: input.baseUrl || existing?.baseUrl || spec.defaultBaseUrl,
      apiKey: apiKey || null,
      config: input.config ?? existing?.config ?? {},
    };
    return c.json(await testProvider(f, target, { model: typeof body?.model === "string" ? body.model : undefined }));
  });

  // ----- saved models (the subset the user picked, with manual capability flags) -----

  app.get("/providers/:id/models", async (c) => {
    const row = await getRow(c, c.req.param("id"));
    if (!row) return c.json({ error: "not_found", message: "找不到供應商" }, 404);
    const list = await c.get("database").db.select().from(models).where(eq(models.providerId, row.id)).orderBy(asc(models.modelId));
    return c.json(list);
  });

  /** Replace the saved model set. Body: { models: [{ modelId, displayName?, capabilities?, contextLength?, embeddingDim?, enabled? }] } */
  app.put("/providers/:id/models", async (c) => {
    const row = await getRow(c, c.req.param("id"));
    if (!row) return c.json({ error: "not_found", message: "找不到供應商" }, 404);
    const body = await c.req.json().catch(() => null);
    if (!Array.isArray(body?.models) || body.models.length > 500) throw new BadInput("models 必須是陣列（最多 500 筆）");
    const db = c.get("database").db;
    const wanted = body.models.map((m: any) => {
      const modelId = str(m?.modelId, "modelId", 200);
      if (!modelId) throw new BadInput("modelId 必填");
      const caps: Record<string, boolean> = {};
      for (const [k, v] of Object.entries(m.capabilities ?? {})) if (typeof v === "boolean") caps[k] = v;
      const num = (v: unknown) => (Number.isInteger(v) && (v as number) > 0 ? (v as number) : null);
      return {
        providerId: row.id, modelId, displayName: typeof m.displayName === "string" ? m.displayName.trim().slice(0, 200) || null : null, capabilities: caps,
        contextLength: num(m.contextLength), embeddingDim: num(m.embeddingDim), enabled: m.enabled !== false,
      };
    });
    const ids = new Set(wanted.map((w: { modelId: string }) => w.modelId));
    const current = await db.select({ id: models.id, modelId: models.modelId }).from(models).where(eq(models.providerId, row.id));
    for (const cur of current) if (!ids.has(cur.modelId)) await db.delete(models).where(eq(models.id, cur.id));
    for (const w of wanted) {
      await db.insert(models).values(w).onConflictDoUpdate({
        target: [models.providerId, models.modelId],
        set: { displayName: w.displayName, capabilities: w.capabilities, contextLength: w.contextLength, embeddingDim: w.embeddingDim, enabled: w.enabled },
      });
    }
    const list = await db.select().from(models).where(and(eq(models.providerId, row.id))).orderBy(asc(models.modelId));
    return c.json(list);
  });
}
