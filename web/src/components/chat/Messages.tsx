import { useState } from "react";
import { Check, ChevronLeft, ChevronRight, Copy, FileText, Pencil, RefreshCw } from "lucide-react";
import type { Part, PendingApprovalDTO, StoredMessageDTO, ToolInfoDTO, ApprovalDecision } from "@edgemind/shared";
import { Button } from "@/components/ui/button";
import { ApprovalCard, Markdown, Reasoning, ToolCard, type ToolState, type WaitingKind } from "./Parts";
import type { Tree, Turn } from "@/lib/tree";
import { siblingsOf } from "@/lib/tree";

export interface LiveCall {
  id: string;
  name: string;
  argsText: string;
  args?: unknown;
  ended?: boolean;
}

export interface LiveState {
  runId: string | null;
  mode: "stream" | "background";
  text: string;
  reasoning: string;
  reasoningOpen: boolean;
  calls: LiveCall[];
  results: Record<string, { result: unknown; isError?: boolean }>;
  approvals: PendingApprovalDTO[];
  status: string;
  error?: string;
}

const textOfParts = (parts: Part[]) => parts.flatMap((p) => (p.type === "text" ? [p.text] : [])).join("\n\n");

function CopyButton({ text }: { text: string }) {
  const [ok, setOk] = useState(false);
  return (
    <Button variant="ghost" size="icon" className="h-7 w-7" title="複製" aria-label="複製"
      onClick={() => navigator.clipboard.writeText(text).then(() => { setOk(true); setTimeout(() => setOk(false), 1500); })}>
      {ok ? <Check /> : <Copy />}
    </Button>
  );
}

function BranchSwitcher({ tree, msg, onSwitch }: { tree: Tree; msg: StoredMessageDTO; onSwitch(id: string): void }) {
  const sibs = siblingsOf(tree, msg);
  if (sibs.length < 2) return null;
  const i = sibs.findIndex((s) => s.id === msg.id);
  return (
    <span className="flex items-center text-xs text-muted-foreground">
      <Button variant="ghost" size="icon" className="h-7 w-7" disabled={i <= 0} onClick={() => onSwitch(sibs[i - 1].id)} aria-label="上一個分支"><ChevronLeft /></Button>
      {i + 1} / {sibs.length}
      <Button variant="ghost" size="icon" className="h-7 w-7" disabled={i >= sibs.length - 1} onClick={() => onSwitch(sibs[i + 1].id)} aria-label="下一個分支"><ChevronRight /></Button>
    </span>
  );
}

function UserParts({ parts }: { parts: Part[] }) {
  return (
    <>
      {parts.map((p, i) => {
        if (p.type === "text") return <div key={i} className="whitespace-pre-wrap">{p.text}</div>;
        if (p.type === "image") return <img key={i} src={p.data ? `data:${p.mime};base64,${p.data}` : p.url} alt="附加圖片" className="mt-2 max-h-64 rounded-lg" />;
        if (p.type === "file")
          return (
            <div key={i} className="mt-2 inline-flex items-center gap-1.5 rounded-md border bg-background/60 px-2 py-1 text-xs">
              <FileText className="h-3.5 w-3.5" /> {p.name}
            </div>
          );
        return null;
      })}
    </>
  );
}

export function UserMessage(props: { tree: Tree; msg: StoredMessageDTO; busy: boolean; onEdit(text: string): void; onSwitch(id: string): void }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");
  const text = textOfParts(props.msg.parts);
  return (
    <div className="group flex flex-col items-end">
      {editing ? (
        <div className="w-full max-w-[85%] rounded-xl border bg-card p-2">
          <textarea value={draft} onChange={(e) => setDraft(e.target.value)} rows={Math.min(10, draft.split("\n").length + 1)}
            className="w-full resize-y bg-transparent p-2 text-sm outline-none" autoFocus />
          <div className="flex justify-end gap-2">
            <Button size="sm" variant="ghost" onClick={() => setEditing(false)}>取消</Button>
            <Button size="sm" disabled={!draft.trim() || props.busy} onClick={() => { setEditing(false); props.onEdit(draft); }}>送出（建立新分支）</Button>
          </div>
        </div>
      ) : (
        <div className="max-w-[85%] rounded-2xl bg-secondary px-4 py-2.5 text-sm text-secondary-foreground"><UserParts parts={props.msg.parts} /></div>
      )}
      <div className="mt-1 flex items-center gap-0.5 opacity-60 group-hover:opacity-100">
        <BranchSwitcher tree={props.tree} msg={props.msg} onSwitch={props.onSwitch} />
        {!props.msg.id.startsWith("pending") && !editing && (
          <Button variant="ghost" size="icon" className="h-7 w-7" title="編輯" aria-label="編輯" disabled={props.busy} onClick={() => { setDraft(text); setEditing(true); }}><Pencil /></Button>
        )}
        <CopyButton text={text} />
      </div>
    </div>
  );
}

export function AssistantTurn(props: {
  tree: Tree;
  turn: Turn;
  live: LiveState | null;
  isLast: boolean;
  busy: boolean;
  /** A run of this conversation is live (streaming, polling, or waiting on an approval / the browser). */
  runActive: boolean;
  /** The run stopped between segments or was cut off and can be continued (the page shows 繼續執行). */
  runPaused: boolean;
  tools: ToolInfoDTO[];
  onRegenerate(): void;
  onSwitch(id: string): void;
  onDecide(a: PendingApprovalDTO, d: ApprovalDecision): Promise<void>;
  onAnswer(a: PendingApprovalDTO, answer: string): Promise<void>;
  onStartClient(a: PendingApprovalDTO, force: boolean): void;
}) {
  const { turn, live } = props;
  const riskOf = (name: string) => props.tools.find((t) => t.name === name)?.risk ?? "unknown";
  const results = new Map<string, { result: unknown; isError?: boolean }>();
  for (const m of turn.replies) for (const p of m.parts) if (p.type === "tool_result") results.set(p.callId, { result: p.result, isError: p.isError });
  if (props.isLast && live) for (const [k, v] of Object.entries(live.results)) if (!results.has(k)) results.set(k, v);
  const waiting = new Map<string, WaitingKind>(props.isLast && live ? live.approvals.map((a) => [a.toolCallId, a.kind]) : []);

  const firstAssistant = turn.replies.find((m) => m.role === "assistant");
  const copyText = turn.replies.filter((m) => m.role === "assistant").map((m) => textOfParts(m.parts)).filter(Boolean).join("\n\n");
  const showLive = props.isLast && live;

  const callState = (id: string): ToolState => {
    const r = results.get(id);
    if (r) return r.isError ? "error" : "done";
    if (waiting.has(id)) return "waiting";
    // No result: only the last turn of a live run can still produce one; otherwise never show 執行中 forever.
    if (props.isLast && props.runActive) return "running";
    if (props.isLast && props.runPaused) return "paused";
    return "interrupted";
  };

  if (!turn.replies.length && !showLive) return null;
  return (
    <div className="group text-sm">
      {turn.replies.map((m) =>
        m.role !== "assistant" ? null : (
          <div key={m.id}>
            {m.parts.map((p, i) => {
              if (p.type === "reasoning") return <Reasoning key={i} text={p.text} redacted={!!p.redacted && !p.text} />;
              if (p.type === "text") return p.text ? <Markdown key={i} text={p.text} /> : null;
              if (p.type === "tool_call") return <ToolCard key={i} name={p.name} args={p.args} result={results.get(p.id)?.result} state={callState(p.id)} waitingKind={waiting.get(p.id)} risk={riskOf(p.name)} />;
              if (p.type === "image") return <img key={i} src={p.data ? `data:${p.mime};base64,${p.data}` : p.url} alt="" className="my-2 max-h-96 rounded-lg" />;
              return null;
            })}
          </div>
        ),
      )}
      {showLive && (
        <div>
          {live.reasoning && <Reasoning text={live.reasoning} live={live.reasoningOpen} />}
          {live.text && <Markdown text={live.text} streaming />}
          {live.calls.map((c) => (
            <ToolCard key={c.id} name={c.name} args={c.args} argsText={c.ended ? undefined : c.argsText} result={results.get(c.id)?.result} state={c.ended ? callState(c.id) : "streaming"} waitingKind={waiting.get(c.id)} risk={riskOf(c.name)} />
          ))}
          {live.approvals.map((a) => (
            <ApprovalCard key={a.id} a={a} onDecide={(d) => props.onDecide(a, d)} onAnswer={(ans) => props.onAnswer(a, ans)} onStartClient={(force) => props.onStartClient(a, force)} />
          ))}
          {live.error && <div className="my-2 rounded-lg border border-destructive/40 bg-destructive/5 p-3 text-destructive">{live.error}</div>}
          {props.busy && !live.text && !live.reasoning && !live.calls.length && !live.approvals.length && (
            <div className="flex gap-1 py-2"><span className="h-2 w-2 animate-bounce rounded-full bg-muted-foreground/60" /><span className="h-2 w-2 animate-bounce rounded-full bg-muted-foreground/60 [animation-delay:150ms]" /><span className="h-2 w-2 animate-bounce rounded-full bg-muted-foreground/60 [animation-delay:300ms]" /></div>
          )}
        </div>
      )}
      {!(props.isLast && props.busy) && turn.replies.length > 0 && (
        <div className="mt-1 flex items-center gap-0.5 opacity-60 group-hover:opacity-100">
          {firstAssistant && <BranchSwitcher tree={props.tree} msg={firstAssistant} onSwitch={props.onSwitch} />}
          {copyText && <CopyButton text={copyText} />}
          {turn.user && (
            <Button variant="ghost" size="icon" className="h-7 w-7" title="重新生成" aria-label="重新生成" disabled={props.busy} onClick={props.onRegenerate}><RefreshCw /></Button>
          )}
        </div>
      )}
    </div>
  );
}
