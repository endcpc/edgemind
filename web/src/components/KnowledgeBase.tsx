import { useCallback, useEffect, useRef, useState, type DragEvent } from "react";
import { BookOpen, ChevronDown, ChevronRight, Download, ExternalLink, Eye, Loader2, Pencil, Plus, RefreshCw, Search, Trash2, Upload } from "lucide-react";
import { toast } from "sonner";
import {
  getKindSpec, type KbChunkDTO, type KbCollectionDTO, type KbDocumentDTO, type KbIndexProgress, type KbSearchHit, type ProviderDTO, type UploadTicket,
} from "@edgemind/shared";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";
import { ConfirmDialog } from "@/components/PromptDialog";
import { api } from "@/lib/api";
import { KB_ACCEPT, parseAndChunk } from "@/lib/kbparse";
import { uploadWithTicket } from "@/lib/upload";

const fmtSize = (n: number) => (n < 1024 ? `${n} B` : n < 1024 ** 2 ? `${(n / 1024).toFixed(1)} KB` : `${(n / 1024 ** 2).toFixed(1)} MB`);
const STATUS: Record<string, { label: string; variant: "secondary" | "success" | "destructive" | "outline" }> = {
  idle: { label: "已就緒", variant: "success" },
  indexing: { label: "索引中", variant: "secondary" },
  reindexing: { label: "重建索引中", variant: "secondary" },
  error: { label: "索引錯誤", variant: "destructive" },
};
const DOC_STATUS: Record<string, string> = { uploading: "上傳中", parsing: "處理中", ready: "已切塊", error: "失敗" };

/** Chunk POST batches: ≤300 chunks and ≈1.5 MB per request (Netlify body limit 6 MB). */
function batches<T extends { content: string }>(items: T[]): T[][] {
  const out: T[][] = [];
  let cur: T[] = [];
  let bytes = 0;
  for (const it of items) {
    const b = it.content.length * 3;
    if (cur.length && (cur.length >= 300 || bytes + b > 1_500_000)) {
      out.push(cur);
      cur = [];
      bytes = 0;
    }
    cur.push(it);
    bytes += b;
  }
  if (cur.length) out.push(cur);
  return out;
}

interface Job {
  key: string;
  name: string;
  stage: string;
  progress: number;
  error?: string;
}

/** Knowledge bases of one scope: global (projectId = null) or a project's own collections. */
export function KnowledgeBase({ projectId }: { projectId: string | null }) {
  const [cols, setCols] = useState<KbCollectionDTO[] | null>(null);
  const [editing, setEditing] = useState<KbCollectionDTO | "new" | null>(null);
  const [deleting, setDeleting] = useState<KbCollectionDTO | null>(null);
  const [open, setOpen] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setCols(await api<KbCollectionDTO[]>(`/kb/collections?projectId=${projectId ?? "none"}`));
    } catch (e) {
      toast.error((e as Error).message);
      setCols([]);
    }
  }, [projectId]);
  useEffect(() => {
    load();
  }, [load]);

  return (
    <Card>
      <CardHeader className="flex-row items-start justify-between gap-2 space-y-0">
        <div>
          <CardTitle className="flex items-center gap-2"><BookOpen className="h-5 w-5" />知識庫</CardTitle>
          <CardDescription>
            {projectId ? "本專案的知識庫會自動附加到專案內的對話（kb_search 工具）。" : "全域知識庫可在所有對話中以 kb_search 檢索。"}
            檔案直接上傳到物件儲存，並在瀏覽器中解析與切塊；向量化在伺服器端分批進行。
          </CardDescription>
        </div>
        <Button size="sm" onClick={() => setEditing("new")}><Plus className="mr-1 h-4 w-4" />新增知識庫</Button>
      </CardHeader>
      <CardContent className="space-y-3">
        {cols === null && <Loader2 className="h-5 w-5 animate-spin" />}
        {cols?.length === 0 && <p className="text-sm text-muted-foreground">尚未建立知識庫。</p>}
        {cols?.map((c) => (
          <CollectionRow
            key={c.id}
            col={c}
            open={open === c.id}
            onToggle={() => setOpen(open === c.id ? null : c.id)}
            onEdit={() => setEditing(c)}
            onDelete={() => setDeleting(c)}
            onChanged={load}
          />
        ))}
      </CardContent>
      {editing && <CollectionDialog projectId={projectId} editing={editing === "new" ? null : editing} onClose={() => setEditing(null)} onSaved={() => { setEditing(null); load(); }} />}
      <ConfirmDialog
        open={!!deleting}
        onOpenChange={(v) => !v && setDeleting(null)}
        title="刪除知識庫"
        description={`「${deleting?.name}」的所有文件、切塊與向量都會刪除，物件儲存中的原檔也會一併移除。`}
        confirmLabel="刪除"
        destructive
        onConfirm={async () => {
          await api(`/kb/collections/${deleting!.id}`, { method: "DELETE" });
          setDeleting(null);
          load();
        }}
      />
    </Card>
  );
}

function CollectionRow({ col, open, onToggle, onEdit, onDelete, onChanged }: { col: KbCollectionDTO; open: boolean; onToggle(): void; onEdit(): void; onDelete(): void; onChanged(): void }) {
  const [prog, setProg] = useState<KbIndexProgress | null>(null);
  const driving = useRef(false);
  const st = STATUS[prog?.status ?? col.indexStatus] ?? STATUS.idle;
  const total = prog?.total ?? col.chunkCount;
  const done = prog?.done ?? col.embeddedCount;
  const remaining = prog ? prog.remaining : col.embeddingDim ? col.chunkCount - col.embeddedCount : 0;

  /** Drive indexing from the browser: each step embeds for ≤ ~40s; a step that finds the lease taken (background worker) just reports progress. */
  const drive = useCallback(async () => {
    if (driving.current) return;
    driving.current = true;
    try {
      for (let i = 0; i < 2000; i++) {
        const r = await api<KbIndexProgress & { skipped?: boolean; embedded: number }>(`/kb/collections/${col.id}/index/step`, { method: "POST", body: {} });
        setProg(r);
        if (r.error || r.remaining === 0) break;
        if (r.skipped || r.embedded === 0) await new Promise((res) => setTimeout(res, 2500));
      }
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      driving.current = false;
      onChanged();
    }
  }, [col.id, onChanged]);

  // resume automatically when the page is open and work is pending (new uploads, model change)
  useEffect(() => {
    if (col.embeddingDim && col.indexStatus !== "error" && col.chunkCount > col.embeddedCount) drive();
  }, [col.id, col.embeddingDim, col.indexStatus, col.chunkCount, col.embeddedCount, drive]);

  const pct = total ? Math.round((done / total) * 100) : 0;
  return (
    <div className="rounded-lg border">
      <div className="flex flex-wrap items-center gap-2 p-3">
        <button className="flex min-w-0 flex-1 items-center gap-2 text-left" onClick={onToggle}>
          {open ? <ChevronDown className="h-4 w-4 shrink-0" /> : <ChevronRight className="h-4 w-4 shrink-0" />}
          <span className="truncate font-medium">{col.name}</span>
          <Badge variant={st.variant}>{st.label}</Badge>
        </button>
        <span className="text-xs text-muted-foreground">
          {col.documentCount} 份文件 · {col.chunkCount} 塊 ·{" "}
          {col.embeddingModel ? `${col.embeddingProviderName ?? ""} ${col.embeddingModel}（${col.embeddingDim} 維）` : "僅全文檢索（未設定 Embedding）"}
          {col.rerankModel ? ` · 重排序 ${col.rerankModel}` : ""}
        </span>
        <Button size="icon" variant="ghost" title="編輯" onClick={onEdit}><Pencil className="h-4 w-4" /></Button>
        <Button size="icon" variant="ghost" title="刪除" onClick={onDelete}><Trash2 className="h-4 w-4" /></Button>
      </div>
      {col.embeddingDim && total > 0 && remaining > 0 && (
        <div className="px-3 pb-3">
          <div className="h-2 overflow-hidden rounded bg-muted"><div className="h-full bg-primary transition-all" style={{ width: `${pct}%` }} /></div>
          <div className="mt-1 text-xs text-muted-foreground">向量化進度 {done}/{total}（{pct}%）{prog?.busy ? "· 背景工作處理中" : ""}</div>
        </div>
      )}
      {(prog?.error ?? col.indexError) && (
        <div className="flex items-center gap-2 px-3 pb-3 text-sm text-destructive">
          <span className="min-w-0 flex-1 break-words">{prog?.error ?? col.indexError}</span>
          <Button size="sm" variant="outline" onClick={async () => { await api(`/kb/collections/${col.id}/index/resume`, { method: "POST", body: {} }).catch(() => {}); setProg(null); drive(); }}>
            <RefreshCw className="mr-1 h-4 w-4" />繼續索引
          </Button>
        </div>
      )}
      {open && <CollectionBody col={col} onChanged={onChanged} onIngested={drive} />}
    </div>
  );
}

function CollectionBody({ col, onChanged, onIngested }: { col: KbCollectionDTO; onChanged(): void; onIngested(): void }) {
  const [docs, setDocs] = useState<KbDocumentDTO[] | null>(null);
  const [jobs, setJobs] = useState<Job[]>([]);
  const [drag, setDrag] = useState(false);
  const [viewing, setViewing] = useState<KbDocumentDTO | null>(null);
  async function openOriginal(d: KbDocumentDTO, download: boolean) {
    try {
      const { url } = await api<{ url: string }>(`/kb/documents/${d.id}/view${download ? "?download=1" : ""}`);
      window.open(url, "_blank", "noopener");
    } catch (e) {
      toast.error((e as Error).message);
    }
  }
  const [deleting, setDeleting] = useState<KbDocumentDTO | null>(null);
  const input = useRef<HTMLInputElement>(null);

  const load = useCallback(async () => {
    setDocs(await api<KbDocumentDTO[]>(`/kb/collections/${col.id}/documents`).catch(() => []));
  }, [col.id]);
  useEffect(() => {
    load();
  }, [load, col.embeddedCount]);

  async function ingest(file: File) {
    const key = `${file.name}-${Date.now()}-${Math.random()}`;
    const set = (patch: Partial<Job>) => setJobs((js) => js.map((j) => (j.key === key ? { ...j, ...patch } : j)));
    setJobs((js) => [...js, { key, name: file.name, stage: "解析中", progress: 0 }]);
    let docId: string | null = null;
    try {
      const chunksP = parseAndChunk(file, { size: col.chunkSize, overlap: col.chunkOverlap });
      chunksP.catch(() => {});
      const getTicket = async (): Promise<UploadTicket> => {
        if (docId) await api(`/kb/documents/${docId}`, { method: "DELETE" }).catch(() => {}); // CORS retry: replace the half-created document
        const r = await api<{ document: KbDocumentDTO; ticket: UploadTicket }>(`/kb/collections/${col.id}/documents`, { method: "POST", body: { name: file.name, size: file.size, mime: file.type || undefined } });
        docId = r.document.id;
        return r.ticket;
      };
      set({ stage: "上傳中" });
      await uploadWithTicket(file, getTicket, (p) => set({ progress: p * 0.5 }));
      set({ stage: "解析與切塊" });
      let chunks;
      try {
        chunks = await chunksP;
      } catch (e) {
        await api(`/kb/documents/${docId}/error`, { method: "POST", body: { message: (e as Error).message } }).catch(() => {});
        throw e;
      }
      const parts = batches(chunks);
      let start = 0;
      for (const [i, b] of parts.entries()) {
        await api(`/kb/documents/${docId}/chunks`, { method: "POST", body: { start, chunks: b, done: i === parts.length - 1 } });
        start += b.length;
        set({ stage: `儲存切塊 ${start}/${chunks.length}`, progress: 0.5 + 0.5 * (start / chunks.length) });
      }
      setJobs((js) => js.filter((j) => j.key !== key));
      toast.success(`「${file.name}」已加入（${chunks.length} 塊）`);
    } catch (e) {
      set({ error: (e as Error).message, stage: "失敗" });
    }
  }

  async function addFiles(list: FileList | File[]) {
    const files = [...list];
    if (!files.length) return;
    // a few at a time: parsing PDFs is CPU-heavy in the browser
    const queue = [...files];
    await Promise.all(Array.from({ length: Math.min(3, queue.length) }, async () => {
      for (let f = queue.shift(); f; f = queue.shift()) await ingest(f);
    }));
    await load();
    onChanged();
    onIngested();
  }

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setDrag(false);
    addFiles(e.dataTransfer.files);
  };

  return (
    <div className="space-y-3 border-t p-3">
      {col.description && <p className="text-sm text-muted-foreground">{col.description}</p>}
      <div
        className={`flex flex-col items-center justify-center gap-2 rounded-lg border-2 border-dashed p-4 text-sm ${drag ? "border-primary bg-accent" : "border-muted"}`}
        onDragOver={(e) => { e.preventDefault(); setDrag(true); }}
        onDragLeave={() => setDrag(false)}
        onDrop={onDrop}
      >
        <span className="text-muted-foreground">拖放檔案到這裡，或</span>
        <Button size="sm" variant="outline" onClick={() => input.current?.click()}><Upload className="mr-1 h-4 w-4" />選擇檔案</Button>
        <span className="text-xs text-muted-foreground">支援 txt、md、程式碼、csv、json、html、pdf、docx</span>
        <input ref={input} type="file" multiple hidden accept={KB_ACCEPT} onChange={(e) => { if (e.target.files) addFiles(e.target.files); e.target.value = ""; }} />
      </div>
      {jobs.map((j) => (
        <div key={j.key} className="text-sm">
          <div className="flex justify-between gap-2"><span className="truncate">{j.name}</span><span className={j.error ? "text-destructive" : "text-muted-foreground"}>{j.error ?? j.stage}</span></div>
          {!j.error && <div className="mt-1 h-1.5 overflow-hidden rounded bg-muted"><div className="h-full bg-primary" style={{ width: `${Math.round(j.progress * 100)}%` }} /></div>}
        </div>
      ))}
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead className="text-left text-xs text-muted-foreground">
            <tr><th className="py-1">文件</th><th>大小</th><th>切塊</th><th>向量</th><th>狀態</th><th /></tr>
          </thead>
          <tbody>
            {docs?.map((d) => (
              <tr key={d.id} className="border-t">
                <td className="max-w-[16rem] truncate py-1.5" title={d.name}>{d.name}</td>
                <td>{fmtSize(d.size)}</td>
                <td>{d.chunkCount}</td>
                <td>{col.embeddingDim ? `${d.embeddedCount}/${d.chunkCount}` : "—"}</td>
                <td title={d.error ?? ""} className={d.status === "error" ? "text-destructive" : ""}>{DOC_STATUS[d.status] ?? d.status}</td>
                <td className="whitespace-nowrap text-right">
                  <Button size="icon" variant="ghost" title="開啟原檔" onClick={() => openOriginal(d, false)}><ExternalLink className="h-4 w-4" /></Button>
                  <Button size="icon" variant="ghost" title="下載原檔" onClick={() => openOriginal(d, true)}><Download className="h-4 w-4" /></Button>
                  <Button size="icon" variant="ghost" title="檢視切塊" onClick={() => setViewing(d)}><Eye className="h-4 w-4" /></Button>
                  <Button size="icon" variant="ghost" title="刪除文件" onClick={() => setDeleting(d)}><Trash2 className="h-4 w-4" /></Button>
                </td>
              </tr>
            ))}
            {docs?.length === 0 && <tr><td colSpan={6} className="py-2 text-muted-foreground">尚無文件。</td></tr>}
          </tbody>
        </table>
      </div>
      <SearchBox col={col} />
      {viewing && <ChunkViewer doc={viewing} onClose={() => setViewing(null)} />}
      <ConfirmDialog
        open={!!deleting}
        onOpenChange={(v) => !v && setDeleting(null)}
        title="刪除文件"
        description={`「${deleting?.name}」的切塊與向量會刪除，物件儲存中的原檔也會移除。`}
        confirmLabel="刪除"
        destructive
        onConfirm={async () => {
          await api(`/kb/documents/${deleting!.id}`, { method: "DELETE" });
          setDeleting(null);
          await load();
          onChanged();
        }}
      />
    </div>
  );
}

function SearchBox({ col }: { col: KbCollectionDTO }) {
  const [q, setQ] = useState("");
  const [busy, setBusy] = useState(false);
  const [res, setRes] = useState<{ hits: KbSearchHit[]; notes: string[]; modes: string[] } | null>(null);
  async function run() {
    if (!q.trim()) return;
    setBusy(true);
    try {
      setRes(await api(`/kb/search`, { method: "POST", body: { query: q, collectionIds: [col.id], topK: 5 } }));
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="space-y-2">
      <form className="flex gap-2" onSubmit={(e) => { e.preventDefault(); run(); }}>
        <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="測試檢索：輸入問題…" />
        <Button type="submit" variant="outline" disabled={busy}>{busy ? <Loader2 className="h-4 w-4 animate-spin" /> : <Search className="h-4 w-4" />}</Button>
      </form>
      {res && (
        <div className="space-y-2">
          <div className="text-xs text-muted-foreground">檢索方式：{res.modes.join(" + ") || "無"}{res.notes.length ? ` · ${res.notes.join("；")}` : ""}</div>
          {res.hits.length === 0 && <div className="text-sm text-muted-foreground">沒有找到相關段落。</div>}
          {res.hits.map((h, i) => (
            <div key={h.chunkId} className="rounded border p-2 text-sm">
              <div className="mb-1 flex flex-wrap gap-2 text-xs text-muted-foreground">
                <span>[{i + 1}] {h.source} · 第 {h.chunkIndex + 1} 塊</span>
                <span>分數 {h.score}</span>
                <span>{h.via.join(" + ")}</span>
              </div>
              <div className="line-clamp-4 whitespace-pre-wrap">{h.content}</div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function ChunkViewer({ doc, onClose }: { doc: KbDocumentDTO; onClose(): void }) {
  const [offset, setOffset] = useState(0);
  const [data, setData] = useState<{ total: number; chunks: KbChunkDTO[] } | null>(null);
  const limit = 20;
  useEffect(() => {
    api<{ total: number; chunks: KbChunkDTO[] }>(`/kb/documents/${doc.id}/chunks?offset=${offset}&limit=${limit}`).then(setData).catch((e) => toast.error(e.message));
  }, [doc.id, offset]);
  return (
    <Dialog open onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-h-[85vh] max-w-3xl overflow-y-auto">
        <DialogHeader><DialogTitle>切塊：{doc.name}</DialogTitle></DialogHeader>
        {!data && <Loader2 className="h-5 w-5 animate-spin" />}
        <div className="space-y-2">
          {data?.chunks.map((c) => (
            <div key={c.id} className="rounded border p-2 text-sm">
              <div className="mb-1 flex gap-2 text-xs text-muted-foreground">
                <span>#{c.chunkIndex + 1}</span>
                <span>{c.content.length} 字</span>
                {c.metadata?.page !== undefined && <span>第 {String(c.metadata.page)} 頁</span>}
                <Badge variant={c.embedded ? "success" : "outline"}>{c.embedded ? "已向量化" : "未向量化"}</Badge>
              </div>
              <div className="whitespace-pre-wrap break-words">{c.content}</div>
            </div>
          ))}
        </div>
        {data && data.total > limit && (
          <DialogFooter>
            <Button variant="outline" disabled={offset === 0} onClick={() => setOffset(Math.max(0, offset - limit))}>上一頁</Button>
            <span className="self-center text-sm text-muted-foreground">{offset + 1}–{Math.min(offset + limit, data.total)} / {data.total}</span>
            <Button variant="outline" disabled={offset + limit >= data.total} onClick={() => setOffset(offset + limit)}>下一頁</Button>
          </DialogFooter>
        )}
      </DialogContent>
    </Dialog>
  );
}

function CollectionDialog({ projectId, editing, onClose, onSaved }: { projectId: string | null; editing: KbCollectionDTO | null; onClose(): void; onSaved(): void }) {
  const [embProviders, setEmb] = useState<ProviderDTO[]>([]);
  const [rrProviders, setRr] = useState<ProviderDTO[]>([]);
  const [savedModels, setSaved] = useState<string[]>([]);
  const [f, setF] = useState({
    name: editing?.name ?? "",
    description: editing?.description ?? "",
    embeddingProviderId: editing?.embeddingProviderId ?? "",
    embeddingModel: editing?.embeddingModel ?? "",
    requestedDim: editing?.requestedDim ? String(editing.requestedDim) : "",
    rerankProviderId: editing?.rerankProviderId ?? "",
    rerankModel: editing?.rerankModel ?? "",
    chunkSize: String(editing?.chunkSize ?? 1000),
    chunkOverlap: String(editing?.chunkOverlap ?? 150),
  });
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF((x) => ({ ...x, [k]: e.target.value }));

  useEffect(() => {
    api<ProviderDTO[]>("/providers?type=embedding").then((l) => setEmb(l.filter((p) => p.enabled))).catch(() => {});
    api<ProviderDTO[]>("/providers?type=rerank").then((l) => setRr(l.filter((p) => p.enabled))).catch(() => {});
  }, []);
  const emb = embProviders.find((p) => p.id === f.embeddingProviderId);
  const rr = rrProviders.find((p) => p.id === f.rerankProviderId);
  useEffect(() => {
    if (!f.embeddingProviderId) return setSaved([]);
    api<{ modelId: string }[]>(`/providers/${f.embeddingProviderId}/models`).then((l) => setSaved(l.map((m) => m.modelId))).catch(() => setSaved([]));
  }, [f.embeddingProviderId]);
  const embSuggestions = [...new Set([...savedModels, ...(emb ? getKindSpec("embedding", emb.kind)?.suggestedModels ?? [] : [])])];
  const rrSuggestions = rr ? getKindSpec("rerank", rr.kind)?.suggestedModels ?? [] : [];
  const embChanged = !!editing && (f.embeddingProviderId !== (editing.embeddingProviderId ?? "") || f.embeddingModel !== (editing.embeddingModel ?? "") || f.requestedDim !== (editing.requestedDim ? String(editing.requestedDim) : ""));

  async function save() {
    setBusy(true);
    try {
      const body = {
        name: f.name,
        description: f.description || null,
        embeddingProviderId: f.embeddingProviderId || null,
        embeddingModel: f.embeddingModel || null,
        requestedDim: f.requestedDim ? Number(f.requestedDim) : null,
        rerankProviderId: f.rerankProviderId || null,
        rerankModel: f.rerankModel || null,
        chunkSize: Number(f.chunkSize),
        chunkOverlap: Number(f.chunkOverlap),
        ...(editing ? {} : { projectId }),
      };
      if (editing) await api(`/kb/collections/${editing.id}`, { method: "PATCH", body });
      else await api(`/kb/collections`, { method: "POST", body });
      toast.success(embChanged ? "已儲存，正在背景重建索引" : "已儲存");
      onSaved();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open onOpenChange={(v) => !v && onClose()}>
      <DialogContent className="max-h-[90vh] max-w-lg overflow-y-auto">
        <DialogHeader><DialogTitle>{editing ? "編輯知識庫" : "新增知識庫"}</DialogTitle></DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1"><Label>名稱</Label><Input value={f.name} onChange={set("name")} /></div>
          <div className="space-y-1"><Label>說明（會提供給模型判斷何時檢索）</Label><Input value={f.description} onChange={set("description")} /></div>
          <div className="space-y-1">
            <Label>Embedding 供應商</Label>
            <NativeSelect value={f.embeddingProviderId} onChange={(e) => setF((x) => ({ ...x, embeddingProviderId: e.target.value, embeddingModel: "" }))}>
              <option value="">不使用（僅全文檢索）</option>
              {embProviders.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
            </NativeSelect>
            {embProviders.length === 0 && <p className="text-xs text-muted-foreground">尚未設定 Embedding 供應商，可到 設定 → 供應商 新增。</p>}
          </div>
          {f.embeddingProviderId && (
            <div className="grid grid-cols-3 gap-2">
              <div className="col-span-2 space-y-1">
                <Label>模型</Label>
                <Input list="kb-emb-models" value={f.embeddingModel} onChange={set("embeddingModel")} placeholder={embSuggestions[0] ?? "模型 ID"} />
                <datalist id="kb-emb-models">{embSuggestions.map((m) => <option key={m} value={m} />)}</datalist>
              </div>
              <div className="space-y-1"><Label>維度（選填）</Label><Input inputMode="numeric" value={f.requestedDim} onChange={set("requestedDim")} placeholder="預設" /></div>
            </div>
          )}
          {embChanged && editing!.chunkCount > 0 && <p className="text-xs text-amber-600">更換 Embedding 模型或維度後，所有 {editing!.chunkCount} 塊會在背景分批重新向量化（可中斷、可續做）；期間仍可用全文檢索。</p>}
          <div className="grid grid-cols-3 gap-2">
            <div className="space-y-1">
              <Label>重排序</Label>
              <NativeSelect value={f.rerankProviderId} onChange={(e) => setF((x) => ({ ...x, rerankProviderId: e.target.value, rerankModel: "" }))}>
                <option value="">不使用</option>
                {rrProviders.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
              </NativeSelect>
            </div>
            {f.rerankProviderId && (
              <div className="col-span-2 space-y-1">
                <Label>重排序模型</Label>
                <Input list="kb-rr-models" value={f.rerankModel} onChange={set("rerankModel")} placeholder={rrSuggestions[0] ?? "模型 ID"} />
                <datalist id="kb-rr-models">{rrSuggestions.map((m) => <option key={m} value={m} />)}</datalist>
              </div>
            )}
          </div>
          <div className="grid grid-cols-2 gap-2">
            <div className="space-y-1"><Label>切塊大小（字元）</Label><Input inputMode="numeric" value={f.chunkSize} onChange={set("chunkSize")} /></div>
            <div className="space-y-1"><Label>重疊（字元）</Label><Input inputMode="numeric" value={f.chunkOverlap} onChange={set("chunkOverlap")} /></div>
          </div>
          <p className="text-xs text-muted-foreground">切塊設定只套用到之後上傳的文件。</p>
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose}>取消</Button>
          <Button onClick={save} disabled={busy || !f.name.trim() || (!!f.embeddingProviderId && !f.embeddingModel.trim()) || (!!f.rerankProviderId && !f.rerankModel.trim())}>
            {busy && <Loader2 className="mr-1 h-4 w-4 animate-spin" />}儲存
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
