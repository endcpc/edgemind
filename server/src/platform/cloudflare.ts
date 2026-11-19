/**
 * Cloudflare Pages Functions adapter. functions/[[path]].ts mounts this; non-/api paths fall through
 * to static assets via context.next().
 */
import { createApp } from "../app";
import { createNeonDatabase } from "../db/client";
import { newVariant } from "quickjs-emscripten-core";
import wasmfileVariant from "@jitl/quickjs-wasmfile-release-sync";
import { loaderFromVariant, setQuickJSLoader } from "../sandbox/quickjs";

/**
 * QuickJS on workerd: compiling wasm from bytes is forbidden, so functions/[[path]].ts imports the .wasm file as a
 * module (wrangler → WebAssembly.Module) and hands it over here; the wasmfile variant's emscripten loader resolves to
 * its `workerd` build through the export conditions.
 */
export function useQuickJSWasmModule(wasmModule: WebAssembly.Module) {
  setQuickJSLoader(loaderFromVariant(newVariant(wasmfileVariant, { wasmModule })));
}

export interface PagesContext {
  request: Request;
  env: Record<string, unknown>;
  waitUntil(p: Promise<unknown>): void;
  next(): Promise<Response>;
  passThroughOnException(): void;
}

/**
 * Streaming responses on Cloudflare have no wall-clock cap while the client is connected, so only the soft
 * budget applies. Background mode: a self-request to the signed internal drive endpoint, which answers 202 and
 * works inside waitUntil (≈30s after the response), chaining itself until the run finishes.
 */
const app = createApp({
  getDatabase: (env) => createNeonDatabase(env.DATABASE_URL),
  platform: {
    name: "cloudflare",
    segment: { softMs: 50_000 },
    minStepMs: 15_000,
    background: { softMs: 20_000, hardMs: 27_000 },
    async startBackground({ origin, runId, token }) {
      const res = await fetch(`${origin}/api/internal/runs/${encodeURIComponent(runId)}/drive`, { method: "POST", headers: { "x-edgemind-drive": token } });
      if (res.status >= 400) throw new Error(`無法啟動背景執行（HTTP ${res.status}）`);
    },
    async startInternal({ origin, path, token }) {
      const res = await fetch(`${origin}${path}`, { method: "POST", headers: { "x-edgemind-drive": token } });
      if (res.status >= 400) throw new Error(`無法啟動背景工作（HTTP ${res.status}）`);
    },
  },
});

export async function handlePages(context: PagesContext): Promise<Response> {
  const url = new URL(context.request.url);
  if (url.pathname !== "/api" && !url.pathname.startsWith("/api/")) return context.next();
  return app.fetch(context.request, context.env, {
    waitUntil: (p: Promise<unknown>) => context.waitUntil(p),
    passThroughOnException: () => context.passThroughOnException(),
    props: {},
  } as never);
}
