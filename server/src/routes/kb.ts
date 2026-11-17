/**
 * Knowledge base API (browser parses + chunks files; the server stores chunks and embeds them in batches):
 *   GET    /api/kb/collections?projectId=<id>|none|all        list (with document / chunk / embedded counts)
 *   POST   /api/kb/collections                                 { name, description?, projectId?, embeddingProviderId?, embeddingModel?, requestedDim?, rerankProviderId?, rerankModel?, chunkSize?, chunkOverlap? }
 *   GET    /api/kb/collections/:id ; PATCH (same fields; a new embedding model/dim → background re-index) ; DELETE (purges S3 kb/{id}/)
 *   GET    /api/kb/collections/:id/documents
 *   POST   /api/kb/collections/:id/documents                   { name, size, mime } → { document, ticket } (browser PUTs to S3 kb/{id}/…, then /api/uploads/:fileId/complete)
 *   POST   /api/kb/documents/:id/chunks                        { start, chunks: [{content, metadata}], done? }  (idempotent per chunk index)
 *   POST   /api/kb/documents/:id/error                         { message }  (browser-side parse failure)
 *   GET    /api/kb/documents/:id/chunks?offset=&limit=         chunk viewer
 *   DELETE /api/kb/documents/:id
 *   GET    /api/kb/collections/:id/progress
 *   POST   /api/kb/collections/:id/index/step                  embed for ≤ ~40s (browser-driven, resumable)
 *   POST   /api/kb/collections/:id/index/resume                (re)start the background indexer
 *   POST   /api/kb/search                                      { query, collectionIds?, projectId?, topK?, rerank? }
 *   POST   /api/internal/kb/:id/index                          HMAC-signed background indexer (Netlify background fn / CF waitUntil chain)
 */
import type { Hono } from "hono";
import { and, asc, eq, inArray, isNull, sql } from "drizzle-orm";
import type { KbChunkDTO, KbCollectionDTO, KbDocumentDTO } from "../../../shared/src/index";
import { KB_MAX_CHUNK_SIZE } from "../../../shared/src/index";
import type { AppDeps, Ctx, HonoEnv } from "../context";
import { runInBackground } from "../context";
import { files, kbChunks, kbCollections, kbDocuments, projects, providers } from "../db/schema";
import { BadInput } from "../lib/errors";
import { hmacHex, timingSafeEqual } from "../lib/crypto";
import { toTsvectorLiteral } from "../lib/textsearch";
import type { AiBinding } from "../providers/probe";
import { attachedCollections, indexStep, probeDimension, progressOf, searchCollections, type Collection, type KbDeps } from "../rag/kb";
import { S3 } from "../storage/s3";
import { guessMime } from "../storage/files";
import { issueUploadTicket, safeName } from "./files";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const isUuid = (v: unknown): v is string => typeof v === "string" && UUID.test(v);

export const kbIndexToken = (secret: string, collectionId: string) => hmacHex(secret, `kbindex:${collectionId}`);

/** Workers AI binding when running on Cloudflare with `[ai] binding = "AI"`. */
export function aiBinding(c: Ctx): AiBinding | null {
  const ai = (c.env as Record<string, unknown> | undefined)?.AI as AiBinding | undefined;
  return ai && typeof ai.run === "function" ? ai : null;
}

const STEP_BUDGET_MS = 40_000;
const MAX_CHUNKS_PER_REQUEST = 500;
const MAX_CHUNK_CHARS = KB_MAX_CHUNK_SIZE * 2;

export function mountKb(app: Hono<HonoEnv>, deps: AppDeps) {
  const kbDeps = (c: Ctx): KbDeps => ({
    database: c.get("database"),
    encKey: c.get("encKey"),
    fetch: deps.fetch ?? ((...a) => fetch(...a)),
    ai: aiBinding(c),
  });
  const s3 = (c: Ctx) => new S3(c.get("env"), deps.s3Fetch);
  const bgBudget = () => Math.max(10_000, (deps.platform?.background?.softMs ?? 13 * 60_000) - 15_000);

  async function getCollection(c: Ctx, id: string): Promise<Collection | null> {
    if (!isUuid(id)) return null;
    const [r] = await c.get("database").db.select().from(kbCollections).where(eq(kbCollections.id, id)).limit(1);
    return r ?? null;
  }

  async function toDTOs(c: Ctx, rows: Collection[]): Promise<KbCollectionDTO[]> {
    if (!rows.length) return [];
    const database = c.get("database");
    const ids = rows.map((r) => r.id);
    const counts = await database.query<{ id: string; docs: number; chunks: number; embedded: number }>(
      `SELECT c.id,
              (SELECT count(*)::int FROM kb_documents d WHERE d.collection_id = c.id) AS docs,
              (SELECT count(*)::int FROM kb_chunks k WHERE k.collection_id = c.id) AS chunks,
              (SELECT count(*)::int FROM kb_chunks k WHERE k.collection_id = c.id AND k.embedding IS NOT NULL
                  AND k.embedding_model = c.embedding_model AND k.embedding_dim = c.embedding_dim) AS embedded
         FROM kb_collections c WHERE c.id = ANY($1::uuid[])`,
      [ids],
    );
    const byId = new Map(counts.map((r) => [r.id, r]));
    const provIds = [...new Set(rows.map((r) => r.embeddingProviderId).filter(Boolean))] as string[];
    const provs = provIds.length ? await database.db.select({ id: providers.id, name: providers.name }).from(providers).where(inArray(providers.id, provIds)) : [];
    const pname = new Map(provs.map((p) => [p.id, p.name]));
    return rows.map((r) => {
      const n = byId.get(r.id);
      return {
        id: r.id, projectId: r.projectId, name: r.name, description: r.description,
        embeddingProviderId: r.embeddingProviderId, embeddingProviderName: r.embeddingProviderId ? pname.get(r.embeddingProviderId) ?? null : null,
        embeddingModel: r.embeddingModel, embeddingDim: r.embeddingDim, requestedDim: r.requestedDim,
        rerankProviderId: r.rerankProviderId, rerankModel: r.rerankModel,
        chunkSize: r.chunkSize, chunkOverlap: r.chunkOverlap,
        indexStatus: r.indexStatus as KbCollectionDTO["indexStatus"], indexError: r.indexError,
        documentCount: n?.docs ?? 0, chunkCount: n?.chunks ?? 0, embeddedCount: n?.embedded ?? 0,
        busy: !!r.indexLeaseUntil && r.indexLeaseUntil.getTime() > Date.now(),
        updatedAt: r.updatedAt.toISOString(),
      };
    });
  }

  /** Start (or chain) the background indexer for a collection. */
  async function kick(c: Ctx, id: string) {
    const env = c.get("env");
    const token = await kbIndexToken(env.JWT_SECRET, id);
    const path = `/api/internal/kb/${id}/index`;
    if (deps.platform?.startInternal) {
      await deps.platform.startInternal({ origin: new URL(c.req.url).origin, path, token, c }).catch((e) => console.error("[edgemind] kb kick failed", e));
      return;
    }
    const d = kbDeps(c);
    runInBackground(c, (async () => {
      for (let i = 0; i < 1000; i++) {
        const r = await indexStep(d, id, bgBudget());
        if (r.skipped || r.error || r.remaining === 0 || r.embedded === 0) return;
      }
    })());
  }

  // ---------- body validation ----------

  async function parseConfig(c: Ctx, body: any, current?: Collection) {
    const db = c.get("database").db;
    const out: Partial<typeof kbCollections.$inferInsert> = {};
    if (body.name !== undefined || !current) {
      const name = String(body.name ?? "").trim();
      if (!name || name.length > 100) throw new BadInput("名稱必須是 1–100 個字");
      out.name = name;
    }
    if (body.description !== undefined) out.description = body.description === null ? null : String(body.description).slice(0, 2000);
    if (!current && body.projectId !== undefined && body.projectId !== null) {
      if (!isUuid(body.projectId)) throw new BadInput("projectId 格式錯誤");
      const [p] = await db.select({ id: projects.id }).from(projects).where(eq(projects.id, body.projectId)).limit(1);
      if (!p) throw new BadInput("找不到專案");
      out.projectId = p.id;
    }
    if (body.embeddingProviderId !== undefined) {
      if (body.embeddingProviderId === null || body.embeddingProviderId === "") {
        out.embeddingProviderId = null;
        out.embeddingModel = null;
        out.embeddingDim = null;
      } else {
        if (!isUuid(body.embeddingProviderId)) throw new BadInput("embeddingProviderId 格式錯誤");
        const [p] = await db.select().from(providers).where(and(eq(providers.id, body.embeddingProviderId), eq(providers.type, "embedding"))).limit(1);
        if (!p) throw new BadInput("找不到 Embedding 供應商");
        out.embeddingProviderId = p.id;
        const model = String(body.embeddingModel ?? "").trim();
        if (!model || model.length > 200) throw new BadInput("請指定 Embedding 模型");
        out.embeddingModel = model;
      }
    }
    if (body.requestedDim !== undefined) {
      if (body.requestedDim === null || body.requestedDim === "") out.requestedDim = null;
      else if (!Number.isInteger(body.requestedDim) || body.requestedDim < 1 || body.requestedDim > 16000) throw new BadInput("維度必須是 1–16000 的整數");
      else out.requestedDim = body.requestedDim;
    }
    if (body.rerankProviderId !== undefined) {
      if (body.rerankProviderId === null || body.rerankProviderId === "") {
        out.rerankProviderId = null;
        out.rerankModel = null;
      } else {
        if (!isUuid(body.rerankProviderId)) throw new BadInput("rerankProviderId 格式錯誤");
        const [p] = await db.select({ id: providers.id }).from(providers).where(and(eq(providers.id, body.rerankProviderId), eq(providers.type, "rerank"))).limit(1);
        if (!p) throw new BadInput("找不到重排序供應商");
        const model = String(body.rerankModel ?? "").trim();
        if (!model) throw new BadInput("請指定重排序模型");
        out.rerankProviderId = p.id;
        out.rerankModel = model.slice(0, 200);
      }
    }
    const size = body.chunkSize ?? current?.chunkSize ?? 1000;
    if (body.chunkSize !== undefined) {
      if (!Number.isInteger(size) || size < 100 || size > KB_MAX_CHUNK_SIZE) throw new BadInput(`切塊大小必須是 100–${KB_MAX_CHUNK_SIZE}`);
      out.chunkSize = size;
    }
    if (body.chunkOverlap !== undefined) {
      if (!Number.isInteger(body.chunkOverlap) || body.chunkOverlap < 0 || body.chunkOverlap > size / 2) throw new BadInput("重疊字數必須介於 0 與切塊大小的一半之間");
      out.chunkOverlap = body.chunkOverlap;
    }
    // embedding identity changed → probe the real dimension (validates key/model too)
    const provider = out.embeddingProviderId !== undefined ? out.embeddingProviderId : current?.embeddingProviderId ?? null;
    const model = out.embeddingModel !== undefined ? out.embeddingModel : current?.embeddingModel ?? null;
    const reqDim = out.requestedDim !== undefined ? out.requestedDim : current?.requestedDim ?? null;
    const changed = !current || provider !== current.embeddingProviderId || model !== current.embeddingModel || reqDim !== current.requestedDim;
    if (changed && provider && model) {
      try {
        out.embeddingDim = await probeDimension(kbDeps(c), provider, model, reqDim);
      } catch (e) {
        throw new BadInput(`無法使用此 Embedding 模型：${(e as Error).message}`);
      }
    } else if (changed) out.embeddingDim = null;
    return { values: out, embeddingChanged: changed && !!current };
  }

  // ---------- collections ----------

  app.get("/kb/collections", async (c) => {
    const q = c.req.query("projectId");
    const db = c.get("database").db;
    const where = q === "none" ? isNull(kbCollections.projectId) : isUuid(q) ? eq(kbCollections.projectId, q) : undefined;
    const rows = await db.select().from(kbCollections).where(where).orderBy(asc(kbCollections.createdAt));
    return c.json(await toDTOs(c, rows));
  });

  app.post("/kb/collections", async (c) => {
    const body = await c.req.json().catch(() => null);
    if (!body || typeof body !== "object") throw new BadInput("請求格式錯誤");
    const { values } = await parseConfig(c, body);
    const [row] = await c.get("database").db.insert(kbCollections).values(values as typeof kbCollections.$inferInsert).returning();
    return c.json((await toDTOs(c, [row]))[0], 201);
  });

  app.get("/kb/collections/:id", async (c) => {
    const row = await getCollection(c, c.req.param("id"));
    if (!row) return c.json({ error: "not_found", message: "找不到知識庫" }, 404);
    return c.json((await toDTOs(c, [row]))[0]);
  });

  app.patch("/kb/collections/:id", async (c) => {
    const cur = await getCollection(c, c.req.param("id"));
    if (!cur) return c.json({ error: "not_found", message: "找不到知識庫" }, 404);
    const body = await c.req.json().catch(() => null);
    if (!body || typeof body !== "object") throw new BadInput("請求格式錯誤");
    const { values, embeddingChanged } = await parseConfig(c, body, cur);
    const patch: Partial<typeof kbCollections.$inferInsert> = { ...values, updatedAt: new Date() };
    if (embeddingChanged) {
      patch.indexError = null;
      patch.indexStatus = values.embeddingDim ? "reindexing" : "idle";
    }
    const [row] = await c.get("database").db.update(kbCollections).set(patch).where(eq(kbCollections.id, cur.id)).returning();
    if (embeddingChanged && row.embeddingDim) await kick(c, row.id);
    return c.json((await toDTOs(c, [row]))[0]);
  });

  app.delete("/kb/collections/:id", async (c) => {
    const cur = await getCollection(c, c.req.param("id"));
    if (!cur) return c.json({ error: "not_found", message: "找不到知識庫" }, 404);
    const db = c.get("database").db;
    const fileRows = await db.select({ id: files.id, s3Key: files.s3Key }).from(files).where(and(eq(files.scope, "kb"), sql`${files.s3Key} LIKE ${`kb/${cur.id}/%`}`));
    const store = s3(c);
    for (const f of fileRows) await store.delete(f.s3Key).catch(() => {});
    if (fileRows.length) await db.delete(files).where(inArray(files.id, fileRows.map((f) => f.id)));
    await db.delete(kbCollections).where(eq(kbCollections.id, cur.id));
    return c.json({ ok: true });
  });

  // ---------- documents ----------

  const docDTO = (d: typeof kbDocuments.$inferSelect, embedded = 0): KbDocumentDTO => ({
    id: d.id, collectionId: d.collectionId, fileId: d.fileId, name: d.name, mime: d.mime, size: d.size,
    status: d.status, error: d.error, chunkCount: d.chunkCount, embeddedCount: embedded, createdAt: d.createdAt.toISOString(),
  });

  app.get("/kb/collections/:id/documents", async (c) => {
    const cur = await getCollection(c, c.req.param("id"));
    if (!cur) return c.json({ error: "not_found", message: "找不到知識庫" }, 404);
    const db = c.get("database").db;
    const docs = await db.select().from(kbDocuments).where(eq(kbDocuments.collectionId, cur.id)).orderBy(asc(kbDocuments.createdAt));
    const emb = cur.embeddingModel && cur.embeddingDim
      ? await c.get("database").query<{ document_id: string; n: number }>(
          `SELECT document_id, count(*)::int AS n FROM kb_chunks WHERE collection_id = $1 AND embedding IS NOT NULL AND embedding_model = $2 AND embedding_dim = $3 GROUP BY document_id`,
          [cur.id, cur.embeddingModel, cur.embeddingDim],
        )
      : [];
    const m = new Map(emb.map((r) => [r.document_id, r.n]));
    return c.json(docs.map((d) => docDTO(d, m.get(d.id) ?? 0)));
  });

  app.post("/kb/collections/:id/documents", async (c) => {
    const cur = await getCollection(c, c.req.param("id"));
    if (!cur) return c.json({ error: "not_found", message: "找不到知識庫" }, 404);
    const body = await c.req.json().catch(() => null);
    const size = Number(body?.size);
    if (!Number.isInteger(size) || size < 0) throw new BadInput("size 必須是非負整數");
    if (size > 512 * 1024 ** 2) throw new BadInput("知識庫單一檔案上限 512 MB");
    const name = safeName(String(body?.name ?? "file"));
    const mime = typeof body?.mime === "string" && body.mime ? body.mime.slice(0, 200) : guessMime(name);
    const db = c.get("database").db;
    const [f] = await db.insert(files).values({
      projectId: cur.projectId, scope: "kb", path: name, s3Key: `kb/${cur.id}/${crypto.randomUUID()}/${name}`, mime, size, status: "pending",
    }).returning();
    const [doc] = await db.insert(kbDocuments).values({ collectionId: cur.id, fileId: f.id, name, mime, size, status: "uploading" }).returning();
    const ticket = await issueUploadTicket(c, deps, f, size);
    return c.json({ document: docDTO(doc), ticket }, 201);
  });

  async function getDoc(c: Ctx, id: string) {
    if (!isUuid(id)) return null;
    const [d] = await c.get("database").db.select().from(kbDocuments).where(eq(kbDocuments.id, id)).limit(1);
    return d ?? null;
  }

  app.post("/kb/documents/:id/chunks", async (c) => {
    const doc = await getDoc(c, c.req.param("id"));
    if (!doc) return c.json({ error: "not_found", message: "找不到文件" }, 404);
    const body = await c.req.json().catch(() => null);
    const start = Number(body?.start ?? 0);
    const chunks = Array.isArray(body?.chunks) ? body.chunks : null;
    if (!Number.isInteger(start) || start < 0) throw new BadInput("start 必須是非負整數");
    if (!chunks || chunks.length > MAX_CHUNKS_PER_REQUEST) throw new BadInput(`chunks 必須是陣列（每次最多 ${MAX_CHUNKS_PER_REQUEST} 塊）`);
    const database = c.get("database");
    const rows = chunks.map((ch: any, i: number) => {
      const content = String(ch?.content ?? "").replace(/\u0000/g, "").slice(0, MAX_CHUNK_CHARS);
      if (!content.trim()) throw new BadInput(`第 ${start + i} 塊內容為空`);
      let metadata = ch?.metadata && typeof ch.metadata === "object" && !Array.isArray(ch.metadata) ? ch.metadata : null;
      if (metadata && JSON.stringify(metadata).length > 4000) metadata = null;
      return {
        collectionId: doc.collectionId, documentId: doc.id, fileId: doc.fileId, chunkIndex: start + i, content, metadata,
        tsv: sql`${toTsvectorLiteral(`${doc.name}\n${content}`)}::tsvector` as unknown as string,
      };
    });
    if (rows.length) {
      await database.db.insert(kbChunks).values(rows).onConflictDoUpdate({
        target: [kbChunks.documentId, kbChunks.chunkIndex],
        set: { content: sql`excluded.content`, metadata: sql`excluded.metadata`, tsv: sql`excluded.tsv`, embedding: null, embeddingDim: null, embeddingModel: null },
      });
    }
    let status = doc.status === "uploading" ? "parsing" : doc.status;
    if (body?.done) {
      const total = start + rows.length;
      await database.db.delete(kbChunks).where(and(eq(kbChunks.documentId, doc.id), sql`${kbChunks.chunkIndex} >= ${total}`));
      status = "ready";
      await database.db.update(kbDocuments).set({ status, chunkCount: total, error: null, updatedAt: new Date() }).where(eq(kbDocuments.id, doc.id));
      const [col] = await database.db.select().from(kbCollections).where(eq(kbCollections.id, doc.collectionId)).limit(1);
      if (col.embeddingDim && total > 0) {
        if (col.indexStatus === "idle" || col.indexStatus === "error") await database.db.update(kbCollections).set({ indexStatus: "indexing", indexError: null }).where(eq(kbCollections.id, col.id));
        if (body?.background !== false) await kick(c, col.id);
      }
    } else if (status !== doc.status) {
      await database.db.update(kbDocuments).set({ status, updatedAt: new Date() }).where(eq(kbDocuments.id, doc.id));
    }
    return c.json({ ok: true, stored: rows.length, status });
  });

  app.post("/kb/documents/:id/error", async (c) => {
    const doc = await getDoc(c, c.req.param("id"));
    if (!doc) return c.json({ error: "not_found", message: "找不到文件" }, 404);
    const body = await c.req.json().catch(() => ({}));
    const [d] = await c.get("database").db.update(kbDocuments).set({ status: "error", error: String(body?.message ?? "解析失敗").slice(0, 500), updatedAt: new Date() }).where(eq(kbDocuments.id, doc.id)).returning();
    return c.json(docDTO(d));
  });

  app.get("/kb/documents/:id/chunks", async (c) => {
    const doc = await getDoc(c, c.req.param("id"));
    if (!doc) return c.json({ error: "not_found", message: "找不到文件" }, 404);
    const offset = Math.max(0, Number(c.req.query("offset") ?? 0) || 0);
    const limit = Math.min(200, Math.max(1, Number(c.req.query("limit") ?? 50) || 50));
    const [col] = await c.get("database").db.select().from(kbCollections).where(eq(kbCollections.id, doc.collectionId)).limit(1);
    const rows = await c.get("database").db
      .select({ id: kbChunks.id, chunkIndex: kbChunks.chunkIndex, content: kbChunks.content, metadata: kbChunks.metadata, model: kbChunks.embeddingModel, dim: kbChunks.embeddingDim, has: sql<boolean>`${kbChunks.embedding} IS NOT NULL` })
      .from(kbChunks).where(eq(kbChunks.documentId, doc.id)).orderBy(asc(kbChunks.chunkIndex)).offset(offset).limit(limit);
    const out: KbChunkDTO[] = rows.map((r) => ({
      id: r.id, chunkIndex: r.chunkIndex, content: r.content, metadata: r.metadata ?? null,
      embedded: !!r.has && r.model === col.embeddingModel && r.dim === col.embeddingDim,
    }));
    return c.json({ document: docDTO(doc), total: doc.chunkCount, offset, chunks: out });
  });

  app.get("/kb/documents/:id/view", async (c) => {
    const doc = await getDoc(c, c.req.param("id"));
    if (!doc?.fileId) return c.json({ error: "not_found", message: "找不到文件" }, 404);
    const [f] = await c.get("database").db.select().from(files).where(eq(files.id, doc.fileId)).limit(1);
    if (!f || f.status === "deleted") return c.json({ error: "not_found", message: "原檔不存在" }, 404);
    const download = c.req.query("download") === "1";
    const url = await s3(c).presign("GET", f.s3Key, 600, {
      "response-content-disposition": `${download ? "attachment" : "inline"}; filename*=UTF-8''${encodeURIComponent(doc.name)}`,
      "response-content-type": f.mime ?? guessMime(doc.name),
    });
    return c.json({ url, mime: f.mime ?? guessMime(doc.name) });
  });

  app.delete("/kb/documents/:id", async (c) => {
    const doc = await getDoc(c, c.req.param("id"));
    if (!doc) return c.json({ error: "not_found", message: "找不到文件" }, 404);
    const db = c.get("database").db;
    if (doc.fileId) {
      const [f] = await db.select().from(files).where(eq(files.id, doc.fileId)).limit(1);
      if (f) {
        const store = s3(c);
        if (f.uploadId) await store.abortMultipart(f.s3Key, f.uploadId).catch(() => {});
        await store.delete(f.s3Key).catch(() => {});
        await db.delete(files).where(eq(files.id, f.id));
      }
    }
    await db.delete(kbDocuments).where(eq(kbDocuments.id, doc.id)); // chunks cascade
    return c.json({ ok: true });
  });

  // ---------- indexing ----------

  app.get("/kb/collections/:id/progress", async (c) => {
    const cur = await getCollection(c, c.req.param("id"));
    if (!cur) return c.json({ error: "not_found", message: "找不到知識庫" }, 404);
    return c.json(await progressOf(c.get("database"), cur));
  });

  app.post("/kb/collections/:id/index/step", async (c) => {
    const cur = await getCollection(c, c.req.param("id"));
    if (!cur) return c.json({ error: "not_found", message: "找不到知識庫" }, 404);
    const budget = Math.min(STEP_BUDGET_MS, (deps.platform?.segment?.softMs ?? 50_000) - 10_000);
    return c.json(await indexStep(kbDeps(c), cur.id, budget));
  });

  app.post("/kb/collections/:id/index/resume", async (c) => {
    const cur = await getCollection(c, c.req.param("id"));
    if (!cur) return c.json({ error: "not_found", message: "找不到知識庫" }, 404);
    if (!cur.embeddingDim) throw new BadInput("此知識庫尚未設定 Embedding 模型");
    await c.get("database").db.update(kbCollections).set({ indexError: null, indexStatus: cur.indexStatus === "error" ? "indexing" : cur.indexStatus }).where(eq(kbCollections.id, cur.id));
    await kick(c, cur.id);
    return c.json({ ok: true }, 202);
  });

  app.post("/internal/kb/:id/index", async (c) => {
    const id = c.req.param("id");
    if (!isUuid(id)) return c.json({ error: "not_found" }, 404);
    const expected = await kbIndexToken(c.get("env").JWT_SECRET, id);
    if (!timingSafeEqual(c.req.header("x-edgemind-drive") ?? "", expected)) return c.json({ error: "unauthorized" }, 401);
    const d = kbDeps(c);
    const work = async () => {
      const r = await indexStep(d, id, bgBudget());
      if (!r.skipped && !r.error && r.remaining > 0 && r.embedded > 0) await kick(c, id); // chain the next invocation
      return r;
    };
    if (deps.platform?.driveInline) return c.json(await work());
    runInBackground(c, work());
    return c.json({ ok: true }, 202);
  });

  // ---------- search (UI test console) ----------

  app.post("/kb/search", async (c) => {
    const body = await c.req.json().catch(() => null);
    const query = String(body?.query ?? "").trim().slice(0, 2000);
    if (!query) throw new BadInput("query 不可為空");
    const database = c.get("database");
    let cols: Collection[];
    if (Array.isArray(body?.collectionIds) && body.collectionIds.length) {
      const ids = body.collectionIds.filter(isUuid);
      cols = ids.length ? await database.db.select().from(kbCollections).where(inArray(kbCollections.id, ids)) : [];
    } else cols = await attachedCollections(database, isUuid(body?.projectId) ? body.projectId : null);
    const topK = Number.isInteger(body?.topK) ? body.topK : 8;
    return c.json(await searchCollections(kbDeps(c), cols, query, { topK, rerank: body?.rerank !== false }));
  });
}
