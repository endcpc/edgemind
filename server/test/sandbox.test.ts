import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { and, eq } from "drizzle-orm";
import type { AgentEvent } from "../../shared/src/index";
import { auditLogs, fileVersions, files, messages, runs, toolApprovals } from "../src/db/schema";
import { parseSse } from "../src/llm";
import { runJavaScript } from "../src/sandbox/quickjs";
import { codeRunTool } from "../src/tools/code";
import { runLiveness } from "../src/routes/chat";
import { STALE_LEASE_MS } from "../src/agent/store";
import type { Platform } from "../src/context";
import { Harness, callsReply, lastEvent, runIdOf, textReply } from "./harness";
import { S3Mock } from "./s3-mock";

const s3 = new S3Mock();
const h = new Harness({ deps: { s3Fetch: s3.fetch } });
let pid: string;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const trailingTools = (body: any) => {
  const out: any[] = [];
  for (let i = body.messages.length - 1; i >= 0 && body.messages[i].role === "tool"; i--) out.unshift(body.messages[i]);
  return out;
};
const toolMsgs = (body: any) => trailingTools(body).map((m: any) => { try { return JSON.parse(m.content); } catch { return m.content; } });

/** POST /api/chat against an app built with a specific platform (segment budgets). */
async function chatWith(platform: Platform, body: Record<string, unknown>) {
  const app = h.app(platform);
  const headers: Record<string, string> = { "content-type": "application/json", cookie: [...h.cookies].map(([k, v]) => `${k}=${v}`).join("; "), "x-csrf-token": h.cookies.get("em_csrf")! };
  const res = await app.request("http://localhost/api/chat", { method: "POST", headers, body: JSON.stringify({ modelId: h.modelRowId, ...body }) }, h.env);
  const events: AgentEvent[] = [];
  for await (const e of parseSse(res.body!)) events.push(JSON.parse(e.data));
  return events;
}

async function projectFile(path: string) {
  const [r] = await h.t.database.db.select().from(files).where(and(eq(files.projectId, pid), eq(files.path, path)));
  return r;
}

beforeAll(async () => {
  await h.setup();
  pid = (await h.client().post("/projects", { name: "程式專案" })).body.id;
});
afterAll(() => h.teardown());
beforeEach(() => {
  h.script = [];
  h.llmBodies = [];
});

describe("QuickJS sandbox", () => {
  it("captures console output and returns the completion / returned value", async () => {
    const r = await runJavaScript("console.log('嗨', {a: 1}); console.error('warn!'); [1, 2, 3].reduce((a, b) => a + b)", { timeoutMs: 2000 });
    expect(r).toMatchObject({ ok: true, value: 6, error: null });
    expect(r.stdout).toBe('嗨 {\n  "a": 1\n}\n');
    expect(r.stderr).toBe("warn!\n");
    const a = await runJavaScript("const x = await Promise.resolve(21); return { doubled: x * 2 }", { timeoutMs: 2000 });
    expect(a.value).toEqual({ doubled: 42 });
    const e = await runJavaScript("throw new TypeError('壞掉了')", { timeoutMs: 2000 });
    expect(e).toMatchObject({ ok: false, errorKind: "error" });
    expect(e.error).toContain("TypeError: 壞掉了");
  });

  it("kills runaway code: timeout, memory limit, stack overflow — and the next run still works", async () => {
    const t = await runJavaScript("while (true) {}", { timeoutMs: 300 });
    expect(t).toMatchObject({ ok: false, errorKind: "timeout" });
    expect(t.durationMs).toBeLessThan(2000);
    const m = await runJavaScript("const a = []; for (let i = 0; ; i++) a.push({ i, s: 'abc' + i })", { timeoutMs: 10_000, memoryLimitBytes: 16 * 1024 * 1024 });
    expect(m).toMatchObject({ ok: false, errorKind: "memory" });
    const s = await runJavaScript("function f() { return f() } f()", { timeoutMs: 2000 });
    expect(s).toMatchObject({ ok: false, errorKind: "stack" });
    expect((await runJavaScript("1 + 1", { timeoutMs: 1000 })).value).toBe(2);
    const p = await runJavaScript("new Promise(() => {})", { timeoutMs: 1000 });
    expect(p.error).toContain("永遠不會完成");
  });

  it("has no network, Node or browser I/O globals", async () => {
    const r = await runJavaScript("['fetch','XMLHttpRequest','WebSocket','require','process','setTimeout','importScripts','Deno','Bun'].map((k) => typeof globalThis[k])", { timeoutMs: 1000 });
    expect(r.value).toEqual(Array(9).fill("undefined"));
    const imp = await runJavaScript("import('node:fs')", { timeoutMs: 1000 });
    expect(imp.ok).toBe(false);
  });

  it("virtual FS: text, base64 and binary; tracks written / deleted paths", async () => {
    const r = await runJavaScript(
      "const t = fs.readFile('in/a.txt'); fs.writeFile('out/b.txt', t.toUpperCase()); fs.writeFile('c.bin', new Uint8Array([0, 255, 7]));" +
        "fs.writeFile('d.txt', 'aGk=', 'base64'); fs.deleteFile('gone.txt'); [fs.readFile('c.bin', 'base64'), Array.from(fs.readFile('c.bin', 'binary')), fs.exists('gone.txt'), fs.listFiles('out/')]",
      { timeoutMs: 2000, files: new Map([["in/a.txt", { data: new TextEncoder().encode("héllo") }], ["gone.txt", { data: new Uint8Array([1]) }]]) },
    );
    expect(r.value).toEqual(["AP8H", [0, 255, 7], false, [{ path: "out/b.txt", size: 6 }]]);
    expect(r.written.sort()).toEqual(["c.bin", "d.txt", "out/b.txt"]);
    expect(r.deleted).toEqual(["gone.txt"]);
    expect(new TextDecoder().decode(r.files.get("out/b.txt")!.data)).toBe("HÉLLO");
    expect(new TextDecoder().decode(r.files.get("d.txt")!.data)).toBe("hi");
  });
});

describe("code_run javascript (agent)", () => {
  it("is dangerous: asks for approval in the default mode", async () => {
    h.script = [callsReply([{ id: "cj0", name: "code_run", args: { language: "javascript", code: "1" } }])];
    const r = await h.chat({ content: "算一下" });
    expect(lastEvent(r.events)).toMatchObject({ status: "waiting_approval" });
    const ap = (r.events.find((e) => e.type === "approval-required") as any).approvals[0];
    expect(ap).toMatchObject({ toolName: "code_run", risk: "dangerous" });
    await h.client().post(`/runs/${runIdOf(r.events)}/stop`, {});
  });

  it("mounts project files, writes results back as new versions, truncates long output into a file", async () => {
    h.script = [
      callsReply([{ id: "fw", name: "file_write", args: { path: "data/in.csv", content: "a,b\n1,2\n3,4\n" } }]),
      callsReply([{
        id: "cj1", name: "code_run",
        args: {
          language: "javascript", files: ["data/"],
          code: "const rows = fs.readFile('data/in.csv').trim().split('\\n').slice(1).map((l) => l.split(',').map(Number));" +
            "const sums = rows.map(([a, b]) => a + b); fs.writeFile('data/in.csv', 'a,b,sum\\n' + rows.map((r, i) => [...r, sums[i]].join(',')).join('\\n'));" +
            "fs.writeFile('out/result.json', JSON.stringify({ sums })); console.log('x'.repeat(30000)); sums",
        },
      }]),
      textReply("完成"),
    ];
    const r = await h.chat({ content: "處理資料", projectId: pid, permissionMode: "full" });
    expect(lastEvent(r.events)).toMatchObject({ status: "completed" });
    const res = toolMsgs(h.llmBodies[2])[0];
    expect(res).toMatchObject({ ok: true, language: "javascript", truncated: true });
    expect(JSON.parse(res.result)).toEqual([3, 7]);
    expect(res.stdout.length).toBeLessThan(21_000);
    expect(res.stdout).toContain("已截斷");
    expect(res.savedFiles.map((f: any) => f.path).sort()).toEqual(["data/in.csv", "out/result.json"]);
    expect(res.fullOutput.path).toMatch(/^code_run_outputs\/.+\.txt$/);

    const csv = await projectFile("data/in.csv");
    expect(csv.version).toBe(2);
    expect(await h.t.database.db.select().from(fileVersions).where(eq(fileVersions.fileId, csv.id))).toHaveLength(1);
    expect(new TextDecoder().decode(s3.objects.get(csv.s3Key)!.body)).toBe("a,b,sum\n1,2,3\n3,4,7");
    const out = await projectFile("out/result.json");
    expect(new TextDecoder().decode(s3.objects.get(out.s3Key)!.body)).toBe('{"sums":[3,7]}');
    const full = await projectFile(res.fullOutput.path);
    expect(new TextDecoder().decode(s3.objects.get(full.s3Key)!.body)).toContain("x".repeat(30000));
  });

  it("outside a project: no file mounts, written files reported as not saved", async () => {
    h.script = [
      callsReply([{ id: "cj2", name: "code_run", args: { language: "javascript", code: "fs.writeFile('a.txt', 'x'); 'ok'" } }, { id: "cj3", name: "code_run", args: { language: "javascript", code: "1", files: ["a.txt"] } }]),
      textReply("ok"),
    ];
    await h.chat({ content: "跑", permissionMode: "full" });
    const [a, b] = toolMsgs(h.llmBodies[1]);
    expect(a).toMatchObject({ ok: true, result: "ok", notSaved: [{ path: "a.txt" }] });
    expect(b).toContain("只能在專案內");
  });

  it("defers to the next segment when the hard deadline is too close (never blocks past it)", async () => {
    h.script = [callsReply([{ id: "cj4", name: "code_run", args: { language: "javascript", code: "6 * 7", timeoutSec: 10 } }])];
    const ev = await chatWith({ name: "test", segment: { softMs: 50_000, hardMs: 3000 } }, { content: "深思", permissionMode: "full" });
    expect(lastEvent(ev).type).toBe("continue");
    expect(ev.some((e) => e.type === "tool-result")).toBe(false);
    h.script = [textReply("42")];
    const r2 = await h.chat({ runId: runIdOf(ev), action: "continue" });
    expect(lastEvent(r2.events)).toMatchObject({ status: "completed" });
    expect(toolMsgs(h.llmBodies[1])[0]).toMatchObject({ ok: true, result: "42" });
  });
});

describe("code_run python (browser-side client tool)", () => {
  it("pauses the run with a client item (mounts resolved), resumes with the browser's result", async () => {
    h.script = [callsReply([{ id: "py1", name: "code_run", args: { language: "python", code: "print('hi')", files: ["data/in.csv"], timeoutSec: 500 } }])];
    const r = await h.chat({ content: "用 Python", projectId: pid, permissionMode: "full" });
    expect(lastEvent(r.events)).toMatchObject({ status: "waiting_approval" });
    const ap = (r.events.find((e) => e.type === "approval-required") as any).approvals[0];
    const csv = await projectFile("data/in.csv");
    expect(ap).toMatchObject({ toolName: "code_run", kind: "client", reason: "等待瀏覽器執行" });
    expect(ap.args).toMatchObject({ language: "python", code: "print('hi')", timeoutSec: 120, projectId: pid, mounts: [{ path: "data/in.csv", fileId: csv.id, size: csv.size }] });
    const runId = runIdOf(r.events);
    const c = h.client();
    // the approval / answer endpoints cannot settle a client item
    expect((await c.post(`/runs/${runId}/approvals`, { toolCallId: "py1", decision: "allow_once" })).status).toBe(404);
    // reload shows the pending client item
    const msgs = await c.get(`/conversations/${(r.events.find((e) => e.type === "run") as any).conversationId}/messages`);
    expect(msgs.body.activeRun.approvals[0]).toMatchObject({ kind: "client", toolCallId: "py1" });

    const fig = await projectFile("out/result.json"); // any existing file id stands in for an uploaded figure
    const post = await c.post(`/runs/${runId}/client-results`, {
      toolCallId: "py1",
      result: {
        ok: true, stdout: "hi\n" + "y".repeat(40_000), stderr: "", result: null, durationMs: 1234,
        files: [{ path: "figures/fig-1.png", fileId: fig.id, size: 10, kind: "figure" }, { path: "fake.png", fileId: "00000000-0000-4000-8000-000000000000", size: 1 }],
      },
    });
    expect(post.body).toMatchObject({ status: "paused", resume: true, remaining: [] });
    expect((await c.post(`/runs/${runId}/client-results`, { toolCallId: "py1", result: { ok: true } })).status).toBe(409);

    h.script = [textReply("Python 跑完了")];
    const r2 = await h.chat({ runId, action: "continue" });
    expect(lastEvent(r2.events)).toMatchObject({ status: "completed" });
    const res = toolMsgs(h.llmBodies[1])[0];
    expect(res).toMatchObject({ ok: true, durationMs: 1234, files: [{ path: "figures/fig-1.png", fileId: fig.id, kind: "figure" }] });
    expect(res.files).toHaveLength(1); // unknown file ids are dropped
    expect(res.stdout.length).toBeLessThan(21_000); // the server caps what the browser reports
    const [row] = await h.t.database.db.select().from(toolApprovals).where(and(eq(toolApprovals.toolCallId, "py1"), eq(toolApprovals.kind, "client")));
    expect(row.status).toBe("approved");
    expect((await h.t.database.db.select().from(auditLogs).where(eq(auditLogs.action, "client_tool_result"))).length).toBe(1);
  });

  it("default mode: approval first, then the browser; cancel → tool error", async () => {
    h.script = [callsReply([{ id: "py2", name: "code_run", args: { language: "python", code: "1/0" } }])];
    const r = await h.chat({ content: "py" });
    const runId = runIdOf(r.events);
    const first = (r.events.find((e) => e.type === "approval-required") as any).approvals[0];
    expect(first).toMatchObject({ toolName: "code_run", risk: "dangerous", reason: expect.not.stringContaining("瀏覽器") });
    expect(first.kind).not.toBe("client");
    const c = h.client();
    expect((await c.post(`/runs/${runId}/approvals`, { toolCallId: "py2", decision: "allow_once" })).body.resume).toBe(true);
    const r2 = await h.chat({ runId, action: "continue" });
    expect((r2.events.find((e) => e.type === "approval-required") as any).approvals[0]).toMatchObject({ kind: "client", toolCallId: "py2" });
    expect((await c.post(`/runs/${runId}/client-results`, { toolCallId: "py2", cancel: true })).body.resume).toBe(true);
    h.script = [textReply("好")];
    await h.chat({ runId, action: "continue" });
    expect(toolMsgs(h.llmBodies[1])[0]).toBe("使用者取消了瀏覽器端執行。");
  });

  it("background mode waits for the browser; an item nobody picks up is skipped after the TTL", async () => {
    h.script = [callsReply([{ id: "py3", name: "code_run", args: { language: "python", code: "print(1)" } }]), textReply("改用 JS")];
    const r = await h.chat({ content: "bg python", mode: "background", permissionMode: "full" });
    expect(r.status).toBe(202);
    const c = h.client();
    // a page can still execute it: the run pauses with a client item instead of failing the tool outright
    let approvals: any[] = [];
    for (let i = 0; i < 100; i++) {
      approvals = ((await c.get(`/runs/${r.json.runId}`)).body as any).approvals ?? [];
      if (approvals.length) break;
      await sleep(20);
    }
    expect(approvals[0]).toMatchObject({ toolName: "code_run", kind: "client" });
    // nobody executes it (tab closed): after the TTL the supervisor skips it so the run moves on
    await h.t.database.query(`UPDATE tool_approvals SET created_at = now() - interval '5 minutes' WHERE run_id = $1 AND tool_call_id = 'py3'`, [r.json.runId]);
    await c.get(`/runs/${r.json.runId}/events?after=0`);
    for (let i = 0; i < 150 && (await c.get(`/runs/${r.json.runId}`)).body.status !== "completed"; i++) await sleep(20);
    expect((await c.get(`/runs/${r.json.runId}`)).body.status).toBe("completed");
    const res = toolMsgs(h.llmBodies[1])[0];
    expect(String(res)).toContain("取消");
  });
});

describe("interrupted / resumable runs (UI must never wait forever)", () => {
  it("runLiveness: stale leases and stream runs that only a `continue` moves on", () => {
    const now = Date.now();
    const old = new Date(now - STALE_LEASE_MS - 1000);
    const fresh = new Date(now - 1000);
    expect(runLiveness({ status: "running", mode: "stream", updatedAt: fresh }, now)).toEqual({ stale: false, resumable: false });
    expect(runLiveness({ status: "running", mode: "stream", updatedAt: old }, now)).toEqual({ stale: true, resumable: true });
    expect(runLiveness({ status: "pending", mode: "stream", updatedAt: old }, now)).toEqual({ stale: true, resumable: true });
    expect(runLiveness({ status: "paused", mode: "stream", updatedAt: fresh }, now)).toEqual({ stale: false, resumable: true });
    expect(runLiveness({ status: "paused", mode: "background", updatedAt: fresh }, now)).toEqual({ stale: false, resumable: false });
    expect(runLiveness({ status: "stopping", mode: "stream", updatedAt: old }, now)).toEqual({ stale: true, resumable: false });
    expect(runLiveness({ status: "waiting_approval", mode: "stream", updatedAt: old }, now)).toEqual({ stale: false, resumable: false });
  });

  it("project chat: python client item survives a lost stream; reload sees it, then paused / stale runs are resumable", async () => {
    h.script = [callsReply([{ id: "pyx", name: "code_run", args: { language: "python", code: "import os\nos.makedirs('ai-blog-astro/docs', exist_ok=True)\nprint('ok')" } }])];
    const r = await h.chat({ content: "建立資料夾", projectId: pid, permissionMode: "full" });
    const runId = runIdOf(r.events);
    const conv = (r.events.find((e) => e.type === "run") as any).conversationId;
    const c = h.client();
    // What a page sees after its SSE stream was cut before `approval-required` / `done`.
    let m = await c.get(`/conversations/${conv}/messages`);
    expect(m.body.activeRun).toMatchObject({ id: runId, status: "waiting_approval", mode: "stream", resumable: false, stale: false });
    expect(m.body.activeRun.approvals).toEqual([expect.objectContaining({ kind: "client", toolCallId: "pyx", toolName: "code_run" })]);
    expect(m.body.activeRun.approvals[0].args).toMatchObject({ language: "python", projectId: pid, conversationId: conv });

    // Browser reports the result; the run is paused until the page continues it.
    const post = await c.post(`/runs/${runId}/client-results`, { toolCallId: "pyx", result: { ok: true, stdout: "ok\n", stderr: "", result: null } });
    expect(post.body).toMatchObject({ status: "paused", resume: true });
    m = await c.get(`/conversations/${conv}/messages`);
    expect(m.body.activeRun).toMatchObject({ status: "paused", resumable: true });
    expect((await c.get(`/runs/${runId}/events?after=0`)).body).toMatchObject({ status: "paused", mode: "stream", resumable: true });

    // A segment that died mid-work (platform time limit) leaves `running` with an expired lease: resumable, and continue works.
    await h.t.database.db.update(runs).set({ status: "running", updatedAt: new Date(Date.now() - STALE_LEASE_MS - 5000) }).where(eq(runs.id, runId));
    m = await c.get(`/conversations/${conv}/messages`);
    expect(m.body.activeRun).toMatchObject({ status: "running", stale: true, resumable: true });
    expect((await c.get(`/runs/${runId}`)).body).toMatchObject({ stale: true, resumable: true });
    h.script = [textReply("完成")];
    const r2 = await h.chat({ runId, action: "continue" });
    expect(lastEvent(r2.events)).toMatchObject({ type: "done", status: "completed" });
    expect(toolMsgs(h.llmBodies[1])[0]).toMatchObject({ ok: true, stdout: "ok\n" });
    expect((await c.get(`/conversations/${conv}/messages`)).body.activeRun).toBeNull();
  });

  it("code_run description steers project file work to the file tools and describes Pyodide accurately", () => {
    const d = codeRunTool.description;
    expect(d).toContain("file_write");
    expect(d).toContain("不要用 code_run 建立");
    expect(d).toContain("Python 沒有 fs 物件");
    expect(d).toContain("空資料夾");
    expect(d).toContain("工作目錄");
  });
});

describe("idempotent resume", () => {
  it("never re-runs a code_run whose result is already recorded (lost checkpoint)", async () => {
    h.script = [
      callsReply([{ id: "idem1", name: "code_run", args: { language: "javascript", files: ["data/in.csv"], code: "fs.writeFile('counter.txt', String(Math.random())); 'ran'" } }]),
      textReply("第一次"),
    ];
    const r = await h.chat({ content: "一次就好", projectId: pid, permissionMode: "full" });
    expect(lastEvent(r.events)).toMatchObject({ status: "completed" });
    const runId = runIdOf(r.events);
    const before = await projectFile("counter.txt");
    expect(before.version).toBe(1);
    const firstResult = toolMsgs(h.llmBodies[1])[0];

    // Simulate a crash after the tool result was recorded in run_steps but before the checkpoint kept it.
    // Two assistant rows exist (tool call + final text); no ORDER BY → pick the one holding the call explicitly.
    const assts = await h.t.database.db.select().from(messages).where(and(eq(messages.runId, runId), eq(messages.role, "assistant")));
    const asst = assts.find((m) => (m.parts as any[]).some((p) => p.type === "tool_call"))!;
    const call = (asst.parts as any[]).find((p) => p.type === "tool_call");
    await h.t.database.db.update(runs).set({ status: "paused", finishedAt: null, checkpoint: { leafId: asst.id, pending: { calls: [call], results: {} } } }).where(eq(runs.id, runId));
    h.llmBodies = [];
    h.script = [textReply("接續")];
    const r2 = await h.chat({ runId, action: "continue" });
    expect(lastEvent(r2.events)).toMatchObject({ status: "completed" });
    expect((await projectFile("counter.txt")).version).toBe(1); // not executed again
    expect(toolMsgs(h.llmBodies[0])[0]).toEqual(firstResult);
  });
});
