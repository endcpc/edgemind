/**
 * Tool registry. Every tool declares a risk level (read / write / dangerous / external) used by the permission
 * gate, a JSON-schema for its arguments, and optionally the permission-relevant targets (paths, domains) of a
 * call so rules like `file_write → docs/**` or `http_request → api.example.com` can be enforced.
 * Real tools (web, files, memory …) arrive in M6; MCP tools register here in M9.
 */
import type { RiskLevel, ToolDef } from "../../../shared/src/index";
import type { Database } from "../db/client";
import type { FileStore } from "../storage/files";
import { webFetchTool, webSearchTool } from "../tools/web";
import { fileTools } from "../tools/files";
import { memoryTools } from "../tools/memory";
import { askUserTool, todoTool } from "../tools/misc";
import { kbSearchTool } from "../tools/kb";
import { skillTools } from "../tools/skills";
import { codeRunTool } from "../tools/code";
import { httpRequestTool } from "../tools/http";
import { imageGenerateTool } from "../tools/image";
import { subagentTool } from "../tools/subagent";
import type { ResolvedModel } from "../llm";
import type { AiBinding } from "../providers/probe";

export interface ToolContext {
  runId: string;
  conversationId: string;
  projectId: string | null;
  signal: AbortSignal;
  database: Database;
  encKey: Uint8Array;
  /** Outbound HTTP (mocked in tests). */
  fetch: typeof fetch;
  /** Project file storage (S3). */
  storage?: FileStore;
  /** Cloudflare Workers AI binding (CF deployments with an AI binding). */
  ai?: AiBinding | null;
  /** Id of the tool call being executed. */
  callId?: string;
  /** The run's resolved model and tool registry (sub-agents reuse them). */
  model?: ResolvedModel;
  registry?: ToolRegistry;
  /** Epoch ms after which the segment aborts in-flight work (undefined = no hard deadline). */
  deadline?: number;
}

/** Thrown by a tool that cannot finish before the segment deadline: the loop pauses and runs it in the next segment. */
export class ToolDeferred extends Error {
  constructor(message = "deferred to the next segment") {
    super(message);
  }
}

export interface ToolTargets {
  paths?: string[];
  domains?: string[];
}

export interface Tool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  risk: RiskLevel;
  /** Only offered when the conversation belongs to a project (file_* tools). */
  projectOnly?: boolean;
  /** Pauses the run for user input (ask_user); bypasses the permission gate. */
  interactive?: boolean;
  /**
   * Client-side execution for these args (code_run python → Pyodide in the browser): after the permission gate the
   * run pauses with a `client` pending item; the web app executes it and POSTs the result. Works in background mode too
   * while a page is watching; an item nobody picks up is skipped after a few minutes (see CLIENT_TOOL_TTL_MS).
   */
  clientSide?(args: any): boolean;
  /** Builds the args stored for the browser (e.g. resolved file mounts). Default: the call's args. */
  prepareClient?(args: any, ctx: ToolContext): Promise<unknown>;
  /** Tool error returned when a client-side call happens in a background run (no browser). */
  clientUnavailable?: string;
  /**
   * Side effects must not repeat: before executing, the loop looks for an already-recorded result of this call in
   * run_steps (e.g. after a crash between recording and checkpointing) and reuses it.
   */
  nonIdempotent?: boolean;
  /** Permission-relevant targets of a call. Default: `path`/`paths`/`url`/`urls` args. */
  targets?(args: any): ToolTargets;
  execute(args: any, ctx: ToolContext): Promise<unknown>;
}

const hostOf = (u: unknown): string[] => {
  if (typeof u !== "string") return [];
  try {
    return [new URL(u).hostname.toLowerCase()];
  } catch {
    return [];
  }
};

export function defaultTargets(args: any): ToolTargets {
  const t: ToolTargets = {};
  if (!args || typeof args !== "object") return t;
  const paths = [args.path, ...(Array.isArray(args.paths) ? args.paths : [])].filter((p) => typeof p === "string");
  const domains = [...hostOf(args.url), ...(Array.isArray(args.urls) ? args.urls.flatMap(hostOf) : [])];
  if (paths.length) t.paths = paths;
  if (domains.length) t.domains = domains;
  return t;
}

export class ToolRegistry {
  private tools = new Map<string, Tool>();

  register(...tools: Tool[]): this {
    for (const t of tools) {
      if (!/^[a-zA-Z0-9_-]{1,64}$/.test(t.name)) throw new Error(`invalid tool name: ${t.name}`);
      this.tools.set(t.name, t);
    }
    return this;
  }

  get(name: string): Tool | undefined {
    return this.tools.get(name);
  }

  list(): Tool[] {
    return [...this.tools.values()];
  }

  /** A copy with extra (e.g. per-run MCP) tools; built-ins win on a name clash. */
  withTools(extra: Tool[]): ToolRegistry {
    const r = new ToolRegistry();
    for (const t of extra) if (!this.tools.has(t.name)) r.tools.set(t.name, t);
    for (const [k, v] of this.tools) r.tools.set(k, v);
    return r;
  }

  targetsOf(tool: Tool, args: unknown): ToolTargets {
    return (tool.targets ?? defaultTargets)(args);
  }

  /** Tool definitions for the model, filtered (e.g. plan mode → read tools only). */
  defs(filter: (t: Tool) => boolean = () => true): ToolDef[] {
    return this.list().filter(filter).map((t) => ({ name: t.name, description: t.description, parameters: t.parameters }));
  }
}

// ---------------- trivial built-ins (testing / smoke) ----------------

export const echoTool: Tool = {
  name: "echo",
  description: "回傳輸入的文字（測試用）。",
  parameters: { type: "object", properties: { text: { type: "string", description: "要回傳的文字" } }, required: ["text"] },
  risk: "read",
  async execute(args) {
    return { text: String(args?.text ?? "") };
  },
};

export const getTimeTool: Tool = {
  name: "get_time",
  description: "取得目前時間（ISO 8601），可指定 IANA 時區，例如 Asia/Taipei。",
  parameters: { type: "object", properties: { tz: { type: "string", description: "IANA 時區" } } },
  risk: "read",
  async execute(args) {
    const tz = typeof args?.tz === "string" && args.tz ? args.tz : "UTC";
    const now = new Date();
    let local: string;
    try {
      local = new Intl.DateTimeFormat("sv-SE", { timeZone: tz, dateStyle: "short", timeStyle: "medium" }).format(now);
    } catch {
      throw new Error(`未知的時區：${tz}`);
    }
    return { iso: now.toISOString(), timeZone: tz, local };
  },
};

export function builtinRegistry(): ToolRegistry {
  return new ToolRegistry().register(echoTool, getTimeTool, webSearchTool, webFetchTool, ...fileTools, ...memoryTools, kbSearchTool, ...skillTools, codeRunTool, httpRequestTool, imageGenerateTool, subagentTool, todoTool, askUserTool);
}
