/**
 * EdgeMind database schema (PLAN §8), single-user edition.
 *
 * Vector strategy (varying embedding dimensions):
 *  - `kb_chunks.embedding` and `memories.embedding` are UNTYPED pgvector columns (`vector` with no
 *    dimension), so any model's output fits. Each row also stores `embedding_dim` + `embedding_model`.
 *  - HNSW indexes need a fixed dimension, so we create PARTIAL EXPRESSION indexes per dimension at
 *    runtime (see `db/vector.ts#ensureVectorIndex`):
 *      CREATE INDEX ... USING hnsw ((embedding::vector(1536)) vector_cosine_ops) WHERE embedding_dim = 1536
 *    and query with the same cast + `embedding_dim = N` filter so the planner uses it.
 *    Dimensions > 2000 use `halfvec(N)` (HNSW limit for vector is 2000, halfvec 4000).
 *  - A kb_collection is bound to one embedding provider/model/dim; changing it triggers a re-index.
 */
import { sql } from "drizzle-orm";
import type { Part } from "../../../shared/src/index";
import {
  pgTable, text, integer, boolean, timestamp, jsonb, uuid, bigint, index, uniqueIndex, customType, real,
} from "drizzle-orm/pg-core";

/** Untyped pgvector column. Accepts number[] and serializes to '[1,2,3]'. */
export const vector = customType<{ data: number[]; driverData: string }>({
  dataType() {
    return "vector";
  },
  toDriver(v: number[]) {
    return `[${v.join(",")}]`;
  },
  fromDriver(v: string) {
    return typeof v === "string" ? (JSON.parse(v) as number[]) : (v as unknown as number[]);
  },
});

export const tsvector = customType<{ data: string }>({
  dataType() {
    return "tsvector";
  },
});

const id = () => uuid("id").primaryKey().defaultRandom();
const createdAt = () => timestamp("created_at", { withTimezone: true }).notNull().defaultNow();
const updatedAt = () => timestamp("updated_at", { withTimezone: true }).notNull().defaultNow();

// ---------- auth (single user) ----------

/** Exactly one row (id = 1) once the owner has set a password. */
export const users = pgTable("users", {
  id: integer("id").primaryKey().default(1),
  passwordHash: text("password_hash").notNull(),
  /** Bumped on password change; JWTs carrying an older value are rejected. */
  tokenVersion: integer("token_version").notNull().default(1),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const sessions = pgTable("sessions", {
  id: id(),
  userAgent: text("user_agent"),
  ip: text("ip"),
  createdAt: createdAt(),
  lastSeenAt: timestamp("last_seen_at", { withTimezone: true }).notNull().defaultNow(),
  expiresAt: timestamp("expires_at", { withTimezone: true }).notNull(),
  revokedAt: timestamp("revoked_at", { withTimezone: true }),
});

/** Failed/successful login attempts for DB-backed rate limiting (serverless has no shared memory). */
export const loginAttempts = pgTable("login_attempts", {
  id: id(),
  ip: text("ip").notNull(),
  success: boolean("success").notNull(),
  createdAt: createdAt(),
}, (t) => [index("login_attempts_ip_time_idx").on(t.ip, t.createdAt)]);

/** Key/value app settings (non-secret, or secret via `secret_enc`). */
export const settings = pgTable("settings", {
  key: text("key").primaryKey(),
  value: jsonb("value"),
  secretEnc: text("secret_enc"),
  updatedAt: updatedAt(),
});

// ---------- providers & models ----------

export const providers = pgTable("providers", {
  id: id(),
  type: text("type").notNull(), // llm | search | embedding | rerank | image
  kind: text("kind").notNull(), // protocol for llm, vendor for others
  name: text("name").notNull(),
  baseUrl: text("base_url").notNull().default(""),
  apiKeyEnc: text("api_key_enc"),
  apiKeyPreview: text("api_key_preview"),
  enabled: boolean("enabled").notNull().default(true),
  priority: integer("priority").notNull().default(100), // lower = tried first
  config: jsonb("config").$type<Record<string, string>>().notNull().default({}),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [index("providers_type_priority_idx").on(t.type, t.priority)]);

export const models = pgTable("models", {
  id: id(),
  providerId: uuid("provider_id").notNull().references(() => providers.id, { onDelete: "cascade" }),
  modelId: text("model_id").notNull(),
  displayName: text("display_name"),
  /** { vision, tools, reasoning, ... } manually marked or detected. */
  capabilities: jsonb("capabilities").$type<Record<string, boolean>>().notNull().default({}),
  contextLength: integer("context_length"),
  embeddingDim: integer("embedding_dim"),
  enabled: boolean("enabled").notNull().default(true),
  createdAt: createdAt(),
}, (t) => [uniqueIndex("models_provider_model_uq").on(t.providerId, t.modelId)]);

// ---------- projects / conversations ----------

export const projects = pgTable("projects", {
  id: id(),
  name: text("name").notNull(),
  description: text("description"),
  instructions: text("instructions"),
  defaultModelId: uuid("default_model_id").references(() => models.id, { onDelete: "set null" }),
  permissionMode: text("permission_mode"), // null = inherit global
  enabledSkills: jsonb("enabled_skills").$type<string[]>(),
  enabledMcpServers: jsonb("enabled_mcp_servers").$type<string[]>(),
  enabledTools: jsonb("enabled_tools").$type<string[]>(),
  archived: boolean("archived").notNull().default(false),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const conversations = pgTable("conversations", {
  id: id(),
  projectId: uuid("project_id").references(() => projects.id, { onDelete: "set null" }),
  title: text("title"),
  modelId: uuid("model_id").references(() => models.id, { onDelete: "set null" }),
  permissionMode: text("permission_mode"),
  pinned: boolean("pinned").notNull().default(false),
  archived: boolean("archived").notNull().default(false),
  /** Rolling summary for compaction. */
  summary: text("summary"),
  /** Last message (inclusive) covered by `summary`; only applies while that message is on the active branch. */
  summaryUpTo: uuid("summary_up_to"),
  summaryUpdatedAt: timestamp("summary_updated_at", { withTimezone: true }),
  /** The leaf message of the active branch. */
  activeLeafId: uuid("active_leaf_id"),
  /** The model's own task list (todo tool). */
  todos: jsonb("todos").$type<{ content: string; status: string }[]>(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [index("conversations_updated_idx").on(t.updatedAt), index("conversations_project_idx").on(t.projectId)]);

/** Unified message parts (see shared/src/llm.ts). */
export type MessagePart = Part;

export const messages = pgTable("messages", {
  id: id(),
  conversationId: uuid("conversation_id").notNull().references(() => conversations.id, { onDelete: "cascade" }),
  /** Tree for branching: edit/regenerate creates a sibling. */
  parentId: uuid("parent_id"),
  role: text("role").notNull(), // user | assistant | tool | system
  parts: jsonb("parts").$type<MessagePart[]>().notNull().default([]),
  modelId: uuid("model_id"),
  runId: uuid("run_id"),
  /** Plain text copy for full-text search. */
  searchText: text("search_text"),
  /** App-tokenized tsvector of search_text (CJK bigrams), see lib/textsearch.ts. Null = not yet backfilled. */
  searchTsv: tsvector("search_tsv"),
  createdAt: createdAt(),
}, (t) => [index("messages_conversation_idx").on(t.conversationId, t.createdAt), index("messages_parent_idx").on(t.parentId), index("messages_search_tsv_idx").using("gin", t.searchTsv)]);

// ---------- runs (agent loop persistence) ----------

export const runs = pgTable("runs", {
  id: id(),
  conversationId: uuid("conversation_id").notNull().references(() => conversations.id, { onDelete: "cascade" }),
  userMessageId: uuid("user_message_id"),
  status: text("status").notNull().default("running"), // pending | running | paused | waiting_approval | stopping | completed | failed | stopped (see agent/loop.ts)
  mode: text("mode").notNull().default("stream"), // stream | background
  modelId: uuid("model_id"),
  permissionMode: text("permission_mode"),
  stepCount: integer("step_count").notNull().default(0),
  maxSteps: integer("max_steps").notNull().default(25),
  /** Serialized loop state for `continue` across ~50s segments. */
  checkpoint: jsonb("checkpoint"),
  /**
   * Background mode only: text/reasoning of the model step being generated right now (throttled, ~1 s), so the page
   * polling the step log can show it live. `base` = last step seq when the step began (stale once a later step exists).
   */
  partial: jsonb("partial"),
  /** Background runs restarted by the supervisor (dead background function / lost chain), see routes/chat.ts. */
  rescueCount: integer("rescue_count").notNull().default(0),
  rescuedAt: timestamp("rescued_at", { withTimezone: true }),
  error: text("error"),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
  finishedAt: timestamp("finished_at", { withTimezone: true }),
}, (t) => [index("runs_conversation_idx").on(t.conversationId)]);

export const runSteps = pgTable("run_steps", {
  id: id(),
  runId: uuid("run_id").notNull().references(() => runs.id, { onDelete: "cascade" }),
  seq: integer("seq").notNull(),
  kind: text("kind").notNull(), // message | tool_call | tool_result | approval | continue | error | done
  payload: jsonb("payload").notNull(),
  createdAt: createdAt(),
}, (t) => [uniqueIndex("run_steps_run_seq_uq").on(t.runId, t.seq)]);

export const toolApprovals = pgTable("tool_approvals", {
  id: id(),
  runId: uuid("run_id").notNull().references(() => runs.id, { onDelete: "cascade" }),
  conversationId: uuid("conversation_id").notNull().references(() => conversations.id, { onDelete: "cascade" }),
  toolCallId: text("tool_call_id").notNull(),
  toolName: text("tool_name").notNull(),
  args: jsonb("args"),
  status: text("status").notNull().default("pending"), // pending | approved | denied
  scope: text("scope"), // once | conversation
  /** approval | question (ask_user) */
  kind: text("kind").notNull().default("approval"),
  /** The user's answer for kind = question. */
  answer: jsonb("answer"),
  createdAt: createdAt(),
  decidedAt: timestamp("decided_at", { withTimezone: true }),
});

// ---------- files ----------

export const files = pgTable("files", {
  id: id(),
  projectId: uuid("project_id").references(() => projects.id, { onDelete: "cascade" }),
  conversationId: uuid("conversation_id").references(() => conversations.id, { onDelete: "set null" }),
  scope: text("scope").notNull(), // upload | project | kb | skill | artifact
  path: text("path").notNull(), // logical path within scope, e.g. docs/a.md
  s3Key: text("s3_key").notNull(),
  mime: text("mime"),
  size: bigint("size", { mode: "number" }).notNull().default(0),
  sha256: text("sha256"),
  version: integer("version").notNull().default(1),
  status: text("status").notNull().default("ready"), // pending | ready | deleted
  /** In-progress S3 multipart upload id (browser-direct upload). */
  uploadId: text("upload_id"),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [index("files_project_path_idx").on(t.projectId, t.path), uniqueIndex("files_s3key_uq").on(t.s3Key)]);

export const fileVersions = pgTable("file_versions", {
  id: id(),
  fileId: uuid("file_id").notNull().references(() => files.id, { onDelete: "cascade" }),
  version: integer("version").notNull(),
  s3Key: text("s3_key").notNull(),
  size: bigint("size", { mode: "number" }).notNull().default(0),
  sha256: text("sha256"),
  createdAt: createdAt(),
}, (t) => [uniqueIndex("file_versions_file_version_uq").on(t.fileId, t.version)]);

// ---------- knowledge base ----------

export const kbCollections = pgTable("kb_collections", {
  id: id(),
  projectId: uuid("project_id").references(() => projects.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  description: text("description"),
  embeddingProviderId: uuid("embedding_provider_id").references(() => providers.id, { onDelete: "set null" }),
  embeddingModel: text("embedding_model"),
  /** Actual vector dimension (detected with a probe embedding when the model is set). */
  embeddingDim: integer("embedding_dim"),
  /** Output dimension requested from the provider (Matryoshka models); null = model default. */
  requestedDim: integer("requested_dim"),
  rerankProviderId: uuid("rerank_provider_id").references(() => providers.id, { onDelete: "set null" }),
  rerankModel: text("rerank_model"),
  chunkSize: integer("chunk_size").notNull().default(1000),
  chunkOverlap: integer("chunk_overlap").notNull().default(150),
  /** idle | indexing | reindexing | error */
  indexStatus: text("index_status").notNull().default("idle"),
  indexError: text("index_error"),
  /** Embedding worker lease (one worker per collection; stale leases are taken over). */
  indexLeaseUntil: timestamp("index_lease_until", { withTimezone: true }),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [index("kb_collections_project_idx").on(t.projectId)]);

export const kbDocuments = pgTable("kb_documents", {
  id: id(),
  collectionId: uuid("collection_id").notNull().references(() => kbCollections.id, { onDelete: "cascade" }),
  fileId: uuid("file_id").references(() => files.id, { onDelete: "set null" }),
  name: text("name").notNull(),
  mime: text("mime"),
  size: bigint("size", { mode: "number" }).notNull().default(0),
  /** uploading | parsing | ready | error */
  status: text("status").notNull().default("uploading"),
  error: text("error"),
  chunkCount: integer("chunk_count").notNull().default(0),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [index("kb_documents_collection_idx").on(t.collectionId)]);

export const kbChunks = pgTable("kb_chunks", {
  id: id(),
  collectionId: uuid("collection_id").notNull().references(() => kbCollections.id, { onDelete: "cascade" }),
  documentId: uuid("document_id").references(() => kbDocuments.id, { onDelete: "cascade" }),
  fileId: uuid("file_id").references(() => files.id, { onDelete: "set null" }),
  chunkIndex: integer("chunk_index").notNull(),
  content: text("content").notNull(),
  metadata: jsonb("metadata").$type<Record<string, unknown>>(),
  embedding: vector("embedding"),
  embeddingDim: integer("embedding_dim"),
  embeddingModel: text("embedding_model"),
  /** App-tokenized (CJK bigrams + words) tsvector literal, see lib/textsearch.ts. */
  tsv: tsvector("tsv"),
  createdAt: createdAt(),
}, (t) => [
  index("kb_chunks_collection_idx").on(t.collectionId),
  uniqueIndex("kb_chunks_document_chunk_uq").on(t.documentId, t.chunkIndex),
  index("kb_chunks_tsv_idx").using("gin", t.tsv),
]);

// ---------- memory ----------

export const memories = pgTable("memories", {
  id: id(),
  scope: text("scope").notNull(), // global | project | conversation
  projectId: uuid("project_id").references(() => projects.id, { onDelete: "cascade" }),
  conversationId: uuid("conversation_id").references(() => conversations.id, { onDelete: "cascade" }),
  content: text("content").notNull(),
  source: text("source").notNull().default("tool"), // tool | auto | user
  embedding: vector("embedding"),
  embeddingDim: integer("embedding_dim"),
  embeddingModel: text("embedding_model"),
  importance: real("importance"),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [index("memories_scope_idx").on(t.scope, t.projectId)]);

// ---------- skills / MCP ----------

export const skills = pgTable("skills", {
  id: id(),
  name: text("name").notNull(),
  description: text("description").notNull().default(""),
  s3Prefix: text("s3_prefix").notNull(),
  source: text("source").notNull().default("upload"), // upload | editor | github | model
  sourceUrl: text("source_url"),
  enabled: boolean("enabled").notNull().default(true),
  /** Manifest of the skill folder on S3 (`{s3Prefix}{path}`), SKILL.md included. */
  files: jsonb("files").$type<{ path: string; size: number; mime: string }[]>().notNull().default([]),
  /** Parsed SKILL.md front matter. */
  frontmatter: jsonb("frontmatter").$type<Record<string, unknown>>().notNull().default({}),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [uniqueIndex("skills_name_uq").on(t.name)]);

export const mcpServers = pgTable("mcp_servers", {
  id: id(),
  name: text("name").notNull(),
  url: text("url").notNull(),
  transport: text("transport").notNull().default("streamable_http"), // streamable_http | sse
  authType: text("auth_type").notNull().default("none"), // none | bearer | headers | oauth
  /** Encrypted JSON: headers / bearer / oauth tokens. */
  authEnc: text("auth_enc"),
  enabled: boolean("enabled").notNull().default(true),
  /** Short unique slug used in model-facing tool names: mcp__{toolPrefix}__{tool}. */
  toolPrefix: text("tool_prefix"),
  /** Streamable HTTP session (reused across serverless invocations; re-initialized on 404). */
  sessionId: text("session_id"),
  protocolVersion: text("protocol_version"),
  serverInfo: jsonb("server_info").$type<Record<string, unknown>>(),
  instructions: text("instructions"),
  lastError: text("last_error"),
  /** Pending OAuth authorization `state` (lookup key for the callback). */
  oauthState: text("oauth_state"),
  lastSyncedAt: timestamp("last_synced_at", { withTimezone: true }),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [uniqueIndex("mcp_servers_prefix_uq").on(t.toolPrefix), index("mcp_servers_oauth_state_idx").on(t.oauthState)]);

export const mcpTools = pgTable("mcp_tools", {
  id: id(),
  serverId: uuid("server_id").notNull().references(() => mcpServers.id, { onDelete: "cascade" }),
  name: text("name").notNull(),
  description: text("description"),
  inputSchema: jsonb("input_schema"),
  enabled: boolean("enabled").notNull().default(true),
  riskLevel: text("risk_level").notNull().default("dangerous"), // read | write | dangerous | external
  title: text("title"),
  /** MCP tool annotations (readOnlyHint, destructiveHint, idempotentHint, openWorldHint). */
  annotations: jsonb("annotations").$type<Record<string, unknown>>(),
  /** True when the user changed the risk level (sync then keeps it). */
  riskCustomized: boolean("risk_customized").notNull().default(false),
  createdAt: createdAt(),
}, (t) => [uniqueIndex("mcp_tools_server_name_uq").on(t.serverId, t.name)]);

// ---------- permissions ----------

export const toolPolicies = pgTable("tool_policies", {
  id: id(),
  scope: text("scope").notNull(), // global | project | conversation
  scopeId: uuid("scope_id"), // project/conversation id; null for global
  toolName: text("tool_name").notNull(), // e.g. file_write, mcp:server/tool, *
  action: text("action").notNull(), // allow | ask | deny
  /** Optional rule, e.g. { pathGlob: "docs/**" } or { domains: ["api.example.com"] } */
  rule: jsonb("rule"),
  createdAt: createdAt(),
}, (t) => [index("tool_policies_scope_idx").on(t.scope, t.scopeId)]);

// ---------- usage & audit ----------

export const usageLogs = pgTable("usage_logs", {
  id: id(),
  providerId: uuid("provider_id"),
  model: text("model"),
  runId: uuid("run_id"),
  kind: text("kind").notNull(), // chat | embedding | rerank | search | image
  inputTokens: integer("input_tokens"),
  outputTokens: integer("output_tokens"),
  cachedTokens: integer("cached_tokens"),
  reasoningTokens: integer("reasoning_tokens"),
  /** models row (price lookup / breakdown); null for non-LLM usage. */
  modelId: uuid("model_id"),
  /** Attribution for usage outside a run (auto titles, memory extraction); runs are joined via run_id. */
  conversationId: uuid("conversation_id"),
  costUsd: real("cost_usd"),
  createdAt: createdAt(),
}, (t) => [index("usage_logs_time_idx").on(t.createdAt), index("usage_logs_run_idx").on(t.runId)]);

export const auditLogs = pgTable("audit_logs", {
  id: id(),
  action: text("action").notNull(), // tool_call | login | settings_change | ...
  runId: uuid("run_id"),
  conversationId: uuid("conversation_id"),
  toolName: text("tool_name"),
  decision: text("decision"), // allow | ask | deny | approved | denied
  detail: jsonb("detail"),
  ip: text("ip"),
  createdAt: createdAt(),
}, (t) => [index("audit_logs_time_idx").on(t.createdAt)]);


// ---------- secrets vault (M11a) ----------

/** Named secrets for http_request `{{secret:NAME}}` injection; values AES-GCM encrypted (AAD `secret:{id}`), never shown to the model. */
export const secrets = pgTable("secrets", {
  id: id(),
  name: text("name").notNull(),
  valueEnc: text("value_enc").notNull(),
  valuePreview: text("value_preview"),
  /** Hostnames the secret may be sent to; `*.example.com` matches any subdomain. Empty = unusable. */
  allowedDomains: jsonb("allowed_domains").$type<string[]>().notNull().default([]),
  description: text("description").notNull().default(""),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [uniqueIndex("secrets_name_uq").on(t.name)]);

// ---------- scheduled tasks (M11b) ----------

/** Agent tasks run on a schedule by the cron dispatcher (POST /api/cron/tick). See server/src/scheduler/. */
export const scheduledTasks = pgTable("scheduled_tasks", {
  id: id(),
  name: text("name").notNull(),
  prompt: text("prompt").notNull(),
  projectId: uuid("project_id").references(() => projects.id, { onDelete: "set null" }),
  modelId: uuid("model_id"),
  permissionMode: text("permission_mode"),
  /** ScheduleSpec (type once|interval|daily|weekly|cron + fields + IANA timezone). */
  schedule: jsonb("schedule").notNull(),
  enabled: boolean("enabled").notNull().default(true),
  nextRunAt: timestamp("next_run_at", { withTimezone: true }),
  /** Claim lease of the dispatcher (prevents double runs across concurrent ticks). */
  leaseUntil: timestamp("lease_until", { withTimezone: true }),
  lastRunAt: timestamp("last_run_at", { withTimezone: true }),
  lastRunId: uuid("last_run_id"),
  lastError: text("last_error"),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
}, (t) => [index("scheduled_tasks_due_idx").on(t.enabled, t.nextRunAt)]);

/** One row per execution of a scheduled task (status comes from the joined run). */
export const scheduledTaskRuns = pgTable("scheduled_task_runs", {
  id: id(),
  taskId: uuid("task_id").notNull().references(() => scheduledTasks.id, { onDelete: "cascade" }),
  runId: uuid("run_id"),
  conversationId: uuid("conversation_id"),
  trigger: text("trigger").notNull(), // schedule | manual
  scheduledFor: timestamp("scheduled_for", { withTimezone: true }),
  error: text("error"),
  createdAt: createdAt(),
}, (t) => [index("scheduled_task_runs_task_idx").on(t.taskId, t.createdAt)]);
