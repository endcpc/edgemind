/**
 * Files & browser-direct uploads (no server proxy):
 *   POST /api/uploads                         { scope: project|upload, projectId?, conversationId?, path|name, size, mime } → presigned PUT or multipart part URLs
 *   POST /api/uploads/:fileId/complete        { parts?: [{partNumber, etag}], sha256? }
 *   POST /api/uploads/:fileId/abort
 *   GET  /api/projects/:id/files              project file list
 *   GET  /api/files/:id | /download | /versions ; POST /api/files/:id/restore { version } ; DELETE /api/files/:id
 *   GET  /api/files/:id/view                  presigned inline URL (image / PDF preview)
 *   GET  /api/files/:id/content ; PUT { text, baseVersion? }   view / edit a text file (≤ 2 MB) in the browser
 *   POST /api/projects/:id/files/text         { path, text } create a new text file
 *   GET  /api/storage/status ; POST /api/storage/cors { origin? }   bucket CORS for the app origin (also applied automatically on first upload)
 */
import type { Hono } from "hono";
import { and, eq } from "drizzle-orm";
import type { FileVersionDTO, UploadTicket } from "../../../shared/src/index";
import type { AppDeps, Ctx, HonoEnv } from "../context";
import { files, projects } from "../db/schema";
import { BadInput } from "../lib/errors";
import { getSetting, setSetting } from "../lib/settings";
import { S3, S3Error } from "../storage/s3";
import { FileStore, guessMime, isTextMime, normalizePath, projectFileKey, toFileDTO } from "../storage/files";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUuid = (v: unknown): v is string => typeof v === "string" && UUID.test(v);

export const MAX_UPLOAD_BYTES = 5 * 1024 ** 3;
export const SINGLE_PUT_MAX = 32 * 1024 ** 2;
const MIN_PART = 8 * 1024 ** 2;

export function s3For(c: Ctx, deps: AppDeps): S3 {
  return new S3(c.get("env"), deps.s3Fetch);
}

export function fileStore(c: Ctx, deps: AppDeps): FileStore {
  return new FileStore(c.get("database"), s3For(c, deps));
}

export function partPlan(size: number): { partSize: number; count: number } {
  let partSize = MIN_PART;
  while (Math.ceil(size / partSize) > 1000) partSize *= 2;
  return { partSize, count: Math.max(1, Math.ceil(size / partSize)) };
}

/** Make sure the bucket allows browser PUT/GET from this origin (idempotent, remembered in settings). */
export async function ensureCors(c: Ctx, deps: AppDeps, origin: string, force = false): Promise<{ applied: boolean; origins: string[]; error?: string }> {
  const database = c.get("database");
  const known = (await getSetting<string[]>(database, "s3_cors_origins")) ?? [];
  if (!force && known.includes(origin)) return { applied: false, origins: known };
  const origins = [...new Set([...known, origin])];
  try {
    await s3For(c, deps).putBucketCors(origins);
    await setSetting(database, "s3_cors_origins", origins);
    return { applied: true, origins };
  } catch (e) {
    return { applied: false, origins: known, error: (e as Error).message };
  }
}

export const originOf = (c: Ctx, explicit?: unknown) => {
  if (typeof explicit === "string" && /^https?:\/\/[^/]+$/.test(explicit)) return explicit;
  const o = c.req.header("origin");
  return o && /^https?:\/\/[^/]+$/.test(o) ? o : new URL(c.req.url).origin;
};


/** Presigned single PUT (≤32 MB) or multipart part URLs for a pending files row; applies bucket CORS first. */
export async function issueUploadTicket(c: Ctx, deps: AppDeps, row: typeof files.$inferSelect, size: number): Promise<UploadTicket & { corsWarning?: string }> {
  const cors = await ensureCors(c, deps, originOf(c));
  const s3 = s3For(c, deps);
  let ticket: UploadTicket;
  if (size <= SINGLE_PUT_MAX) {
    ticket = { fileId: row.id, method: "put", url: await s3.presign("PUT", row.s3Key, 3600), headers: { "content-type": row.mime ?? "application/octet-stream" } };
  } else {
    const uploadId = await s3.createMultipart(row.s3Key, row.mime ?? "application/octet-stream");
    await c.get("database").db.update(files).set({ uploadId }).where(eq(files.id, row.id));
    const { partSize, count } = partPlan(size);
    const parts = await Promise.all(Array.from({ length: count }, (_, i) => s3.presignPart(row.s3Key, uploadId, i + 1).then((url) => ({ partNumber: i + 1, url }))));
    ticket = { fileId: row.id, method: "multipart", partSize, parts };
  }
  return { ...ticket, ...(cors.error ? { corsWarning: `無法自動設定 Bucket CORS：${cors.error}` } : {}) };
}

/** Text files viewable / editable in the browser (also keeps the JSON body under Netlify's 6 MB limit). */
export const TEXT_EDIT_MAX = 2 * 1024 * 1024;

export const safeName = (n: string) => n.replace(/[\\/\x00-\x1f]/g, "_").replace(/^\.+/, "_").slice(0, 200) || "file";

export function mountFiles(app: Hono<HonoEnv>, deps: AppDeps) {
  const ensureCorsLocal = (c: Ctx, origin: string, force = false) => ensureCors(c, deps, origin, force);
  app.post("/uploads", async (c) => {
    const body = await c.req.json().catch(() => null);
    if (!body || typeof body !== "object") throw new BadInput("請求格式錯誤");
    const size = Number(body.size);
    if (!Number.isInteger(size) || size < 0) throw new BadInput("size 必須是非負整數");
    if (size > MAX_UPLOAD_BYTES) throw new BadInput("檔案超過 5 GB 上限");
    const scope = body.scope === "project" ? "project" : body.scope === "upload" ? "upload" : null;
    if (!scope) throw new BadInput("scope 必須是 project 或 upload");
    const database = c.get("database");
    const db = database.db;
    const store = fileStore(c, deps);
    const s3 = store.s3;

    let projectId: string | null = null;
    if (body.projectId !== undefined && body.projectId !== null) {
      if (!isUuid(body.projectId)) throw new BadInput("projectId 格式錯誤");
      const [p] = await db.select({ id: projects.id }).from(projects).where(eq(projects.id, body.projectId)).limit(1);
      if (!p) throw new BadInput("找不到專案");
      projectId = p.id;
    }
    const conversationId = isUuid(body.conversationId) ? body.conversationId : null;

    let row: typeof files.$inferSelect;
    if (scope === "project") {
      if (!projectId) throw new BadInput("上傳專案檔案需要 projectId");
      const path = normalizePath(body.path ?? body.name);
      const mime = typeof body.mime === "string" && body.mime ? body.mime.slice(0, 200) : guessMime(path);
      const existing = await store.find(projectId, path);
      if (existing?.uploadId) await s3.abortMultipart(existing.s3Key, existing.uploadId).catch(() => {});
      if (existing?.status === "ready") {
        await store.snapshot(existing); // browser overwrites the object directly: keep the old content first
        [row] = await db.update(files).set({ mime, uploadId: null, updatedAt: new Date() }).where(eq(files.id, existing.id)).returning();
      } else if (existing) {
        [row] = await db.update(files).set({ mime, status: "pending", version: existing.status === "deleted" ? existing.version + 1 : existing.version, uploadId: null, updatedAt: new Date() }).where(eq(files.id, existing.id)).returning();
      } else {
        [row] = await db.insert(files).values({ projectId, conversationId, scope: "project", path, s3Key: projectFileKey(projectId, path), mime, size, status: "pending" }).returning();
      }
    } else {
      const name = safeName(String(body.name ?? body.path ?? "file"));
      const mime = typeof body.mime === "string" && body.mime ? body.mime.slice(0, 200) : guessMime(name);
      [row] = await db.insert(files).values({
        projectId, conversationId, scope: "upload", path: name, s3Key: `users/1/uploads/${crypto.randomUUID()}/${name}`, mime, size, status: "pending",
      }).returning();
    }

    return c.json(await issueUploadTicket(c, deps, row, size), 201);
  });

  async function rowOr404(c: Ctx, id: string) {
    if (!isUuid(id)) return null;
    const [r] = await c.get("database").db.select().from(files).where(eq(files.id, id)).limit(1);
    return r ?? null;
  }

  app.post("/uploads/:fileId/complete", async (c) => {
    const row = await rowOr404(c, c.req.param("fileId"));
    if (!row) return c.json({ error: "not_found", message: "找不到上傳" }, 404);
    const body = await c.req.json().catch(() => ({}));
    const s3 = s3For(c, deps);
    if (row.uploadId) {
      const parts = Array.isArray(body?.parts) ? body.parts : null;
      if (!parts?.length || parts.some((p: any) => !Number.isInteger(p?.partNumber) || typeof p?.etag !== "string")) throw new BadInput("parts 必須是 [{partNumber, etag}]");
      try {
        await s3.completeMultipart(row.s3Key, row.uploadId, parts);
      } catch (e) {
        if (e instanceof S3Error) return c.json({ error: "s3_error", message: e.message }, 502);
        throw e;
      }
    }
    const head = await s3.head(row.s3Key);
    if (!head) return c.json({ error: "not_uploaded", message: "物件儲存中找不到已上傳的檔案，請重新上傳" }, 409);
    const sha = typeof body?.sha256 === "string" && /^[0-9a-f]{64}$/i.test(body.sha256) ? body.sha256.toLowerCase() : null;
    const [r] = await c.get("database").db.update(files)
      .set({ size: head.size, sha256: sha, uploadId: null, status: "ready", version: row.status === "ready" ? row.version + 1 : row.version, updatedAt: new Date() })
      .where(eq(files.id, row.id)).returning();
    return c.json(toFileDTO(r));
  });

  app.post("/uploads/:fileId/abort", async (c) => {
    const row = await rowOr404(c, c.req.param("fileId"));
    if (!row) return c.json({ error: "not_found", message: "找不到上傳" }, 404);
    const s3 = s3For(c, deps);
    if (row.uploadId) await s3.abortMultipart(row.s3Key, row.uploadId).catch(() => {});
    const db = c.get("database").db;
    if (row.status === "pending") {
      await s3.delete(row.s3Key).catch(() => {});
      await db.delete(files).where(eq(files.id, row.id));
    } else await db.update(files).set({ uploadId: null }).where(eq(files.id, row.id));
    return c.json({ ok: true });
  });

  app.get("/projects/:id/files", async (c) => {
    const id = c.req.param("id");
    if (!isUuid(id)) return c.json({ error: "not_found" }, 404);
    const rows = await fileStore(c, deps).list(id, c.req.query("dir") ? normalizePath(c.req.query("dir"), { allowEmpty: true }) : "");
    return c.json(rows.map(toFileDTO));
  });

  app.get("/files/:id", async (c) => {
    const row = await rowOr404(c, c.req.param("id"));
    if (!row) return c.json({ error: "not_found", message: "找不到檔案" }, 404);
    return c.json(toFileDTO(row));
  });

  app.get("/files/:id/download", async (c) => {
    const row = await rowOr404(c, c.req.param("id"));
    if (!row || row.status !== "ready") return c.json({ error: "not_found", message: "找不到檔案" }, 404);
    const name = row.path.split("/").pop() ?? "file";
    const url = await s3For(c, deps).presign("GET", row.s3Key, 600, { "response-content-disposition": `attachment; filename*=UTF-8''${encodeURIComponent(name)}` });
    return c.json({ url });
  });

  app.get("/files/:id/view", async (c) => {
    const row = await rowOr404(c, c.req.param("id"));
    if (!row || row.status !== "ready") return c.json({ error: "not_found", message: "找不到檔案" }, 404);
    const name = row.path.split("/").pop() ?? "file";
    const url = await s3For(c, deps).presign("GET", row.s3Key, 600, {
      "response-content-disposition": `inline; filename*=UTF-8''${encodeURIComponent(name)}`,
      "response-content-type": row.mime ?? guessMime(row.path),
    });
    return c.json({ url, mime: row.mime ?? guessMime(row.path) });
  });

  app.get("/files/:id/content", async (c) => {
    const row = await rowOr404(c, c.req.param("id"));
    if (!row || row.status !== "ready") return c.json({ error: "not_found", message: "找不到檔案" }, 404);
    if (!isTextMime(row.mime, row.path)) return c.json({ error: "not_text", message: "這不是文字檔，無法線上編輯；請下載後開啟" }, 415);
    if (row.size > TEXT_EDIT_MAX) return c.json({ error: "too_large", message: "文字檔超過 2 MB，請下載後編輯" }, 413);
    const bytes = await fileStore(c, deps).readBytes(row);
    return c.json({ text: new TextDecoder("utf-8").decode(bytes), version: row.version });
  });

  app.put("/files/:id/content", async (c) => {
    const row = await rowOr404(c, c.req.param("id"));
    if (!row || row.status !== "ready" || row.scope !== "project" || !row.projectId) return c.json({ error: "not_found", message: "找不到檔案" }, 404);
    if (!isTextMime(row.mime, row.path)) throw new BadInput("只能線上編輯文字檔");
    const body = await c.req.json().catch(() => null);
    if (typeof body?.text !== "string") throw new BadInput("text 必須是字串");
    if (Number.isInteger(body.baseVersion) && body.baseVersion !== row.version) {
      return c.json({ error: "conflict", message: `檔案已被修改（目前是 v${row.version}），請重新載入後再編輯` }, 409);
    }
    const data = new TextEncoder().encode(body.text);
    if (data.length > TEXT_EDIT_MAX) throw new BadInput("文字檔超過 2 MB，無法線上儲存");
    return c.json(toFileDTO(await fileStore(c, deps).write(row.projectId, row.path, data, row.mime ?? undefined)));
  });

  app.post("/projects/:id/files/text", async (c) => {
    const pid = c.req.param("id");
    if (!isUuid(pid)) return c.json({ error: "not_found" }, 404);
    const [p] = await c.get("database").db.select({ id: projects.id }).from(projects).where(eq(projects.id, pid)).limit(1);
    if (!p) return c.json({ error: "not_found", message: "找不到專案" }, 404);
    const body = await c.req.json().catch(() => null);
    const path = normalizePath(body?.path);
    const text = typeof body?.text === "string" ? body.text : "";
    const store = fileStore(c, deps);
    const existing = await store.find(pid, path);
    if (existing?.status === "ready") return c.json({ error: "exists", message: `「${path}」已存在` }, 409);
    const data = new TextEncoder().encode(text);
    if (data.length > TEXT_EDIT_MAX) throw new BadInput("文字檔超過 2 MB");
    return c.json(toFileDTO(await store.write(pid, path, data)), 201);
  });

  app.get("/files/:id/versions", async (c) => {
    const row = await rowOr404(c, c.req.param("id"));
    if (!row) return c.json({ error: "not_found", message: "找不到檔案" }, 404);
    const vs = await fileStore(c, deps).versions(row.id);
    const out: FileVersionDTO[] = vs.map((v) => ({ version: v.version, size: v.size, sha256: v.sha256, createdAt: v.createdAt.toISOString() }));
    return c.json(out);
  });

  app.post("/files/:id/restore", async (c) => {
    const row = await rowOr404(c, c.req.param("id"));
    if (!row) return c.json({ error: "not_found", message: "找不到檔案" }, 404);
    const body = await c.req.json().catch(() => null);
    if (!Number.isInteger(body?.version)) throw new BadInput("version 必須是整數");
    return c.json(toFileDTO(await fileStore(c, deps).restore(row.id, body.version)));
  });

  app.delete("/files/:id", async (c) => {
    const row = await rowOr404(c, c.req.param("id"));
    if (!row || row.status === "deleted") return c.json({ error: "not_found", message: "找不到檔案" }, 404);
    const store = fileStore(c, deps);
    if (row.scope === "project" && row.projectId && row.status === "ready") await store.delete(row.projectId, row.path);
    else {
      await store.s3.delete(row.s3Key).catch(() => {});
      await c.get("database").db.update(files).set({ status: "deleted", updatedAt: new Date() }).where(and(eq(files.id, row.id)));
    }
    return c.json({ ok: true });
  });

  app.get("/storage/status", async (c) => {
    const env = c.get("env");
    return c.json({ endpoint: env.S3_ENDPOINT, bucket: env.S3_BUCKET, region: env.S3_REGION, corsOrigins: (await getSetting<string[]>(c.get("database"), "s3_cors_origins")) ?? [], origin: originOf(c) });
  });

  app.post("/storage/cors", async (c) => {
    const body = await c.req.json().catch(() => ({}));
    const r = await ensureCorsLocal(c, originOf(c, body?.origin), true);
    if (r.error) return c.json({ ok: false, error: "cors_failed", message: `設定 Bucket CORS 失敗：${r.error}` }, 502);
    return c.json({ ok: true, origins: r.origins });
  });
}
