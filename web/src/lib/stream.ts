import { CSRF_COOKIE, CSRF_HEADER, type AgentEvent } from "@edgemind/shared";
import { ApiError } from "./api";

function csrf(): Record<string, string> {
  const t = document.cookie.split("; ").find((c) => c.startsWith(`${CSRF_COOKIE}=`))?.slice(CSRF_COOKIE.length + 1);
  return t ? { [CSRF_HEADER]: decodeURIComponent(t) } : {};
}

export type ChatPostResult = { kind: "stream" } | { kind: "accepted"; body: { runId: string; conversationId: string; userMessageId?: string; status: string } };

/** No byte at all for this long means the connection is dead, not slow (the server sends a keep-alive every 15 s). */
const IDLE_MS = 20_000;
/** Waiting for the response headers is different: a cold isolate runs migrations before the first byte. */
const CONNECT_MS = 30_000;

/** The SSE connection went silent: the page must resync from the run's step log instead of waiting forever. */
export class StreamIdleError extends Error {
  constructor() {
    super("串流 20 秒沒有收到任何資料");
    this.name = "StreamIdleError";
  }
}

/**
 * POST /api/chat. SSE responses are parsed and handed to `onEvent` until the stream ends;
 * 202 (background mode) returns the JSON body. An idle watchdog aborts a connection that stops delivering bytes.
 */
export async function postChat(body: unknown, onEvent: (e: AgentEvent) => void, signal?: AbortSignal): Promise<ChatPostResult> {
  const ac = new AbortController();
  let idle = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const bump = (ms = IDLE_MS) => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      idle = true;
      ac.abort();
    }, ms);
  };
  const onAbort = () => ac.abort(signal?.reason);
  if (signal) {
    if (signal.aborted) onAbort();
    else signal.addEventListener("abort", onAbort, { once: true });
  }
  bump(CONNECT_MS);
  try {
    return await postChatInner(body, onEvent, ac.signal, bump);
  } catch (e) {
    if (idle) throw new StreamIdleError();
    throw e;
  } finally {
    if (timer) clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
}

async function postChatInner(body: unknown, onEvent: (e: AgentEvent) => void, signal: AbortSignal, bump: (ms?: number) => void): Promise<ChatPostResult> {
  const res = await fetch("/api/chat", {
    method: "POST",
    credentials: "same-origin",
    headers: { "content-type": "application/json", accept: "text/event-stream", ...csrf() },
    body: JSON.stringify(body),
    signal,
  });
  bump(); // headers arrived: from here on only 20 s of silence is a dead stream
  const ct = res.headers.get("content-type") ?? "";
  if (!res.ok) {
    const data = await res.json().catch(() => ({}));
    if (res.status === 401) window.dispatchEvent(new Event("em:unauthorized"));
    throw new ApiError(res.status, data?.error ?? "http_error", data?.message ?? `請求失敗（HTTP ${res.status}）`, data);
  }
  if (!ct.includes("text/event-stream")) return { kind: "accepted", body: await res.json() };
  const reader = res.body!.pipeThrough(new TextDecoderStream()).getReader();
  let buf = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    bump();
    buf += value.replace(/\r\n?/g, "\n");
    let i: number;
    while ((i = buf.indexOf("\n\n")) >= 0) {
      const block = buf.slice(0, i);
      buf = buf.slice(i + 2);
      const data = block.split("\n").filter((l) => l.startsWith("data:")).map((l) => l.slice(5).replace(/^ /, "")).join("\n");
      if (!data) continue;
      try {
        onEvent(JSON.parse(data) as AgentEvent);
      } catch {
        /* malformed event */
      }
    }
  }
  return { kind: "stream" };
}

export function download(filename: string, content: Blob) {
  const url = URL.createObjectURL(content);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
