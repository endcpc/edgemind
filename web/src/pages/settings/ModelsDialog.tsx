import { useEffect, useMemo, useState } from "react";
import { Loader2, RefreshCw, Search } from "lucide-react";
import { toast } from "sonner";
import type { ModelInfo, ProviderDTO } from "@edgemind/shared";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { api } from "@/lib/api";
import { useWorkspace } from "@/lib/workspace";

interface SavedModel {
  modelId: string;
  displayName: string | null;
  capabilities: Record<string, boolean>;
  contextLength: number | null;
  embeddingDim: number | null;
  enabled: boolean;
}

const CAPS: { key: string; label: string }[] = [
  { key: "vision", label: "視覺" },
  { key: "tools", label: "工具" },
  { key: "reasoning", label: "推理" },
];

export function ModelsDialog({ provider, onOpenChange }: { provider: ProviderDTO | null; onOpenChange: (o: boolean) => void }) {
  const ws = useWorkspace();
  const [remote, setRemote] = useState<ModelInfo[]>([]);
  const [picked, setPicked] = useState<Map<string, SavedModel>>(new Map());
  const [manual, setManual] = useState("");
  const [filter, setFilter] = useState("");
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const isLlm = provider?.type === "llm";

  useEffect(() => {
    if (!provider) return;
    setRemote([]);
    setError(null);
    setFilter("");
    api<SavedModel[]>(`/providers/${provider.id}/models`).then((list) => setPicked(new Map(list.map((m) => [m.modelId, m]))));
    fetchRemote();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [provider?.id]);

  async function fetchRemote() {
    if (!provider) return;
    setLoading(true);
    setError(null);
    try {
      setRemote((await api<{ models: ModelInfo[] }>(`/providers/${provider.id}/models/remote`)).models);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setLoading(false);
    }
  }

  const all = useMemo(() => {
    const ids = new Map<string, ModelInfo>(remote.map((m) => [m.id, m]));
    for (const id of picked.keys()) if (!ids.has(id)) ids.set(id, { id });
    const f = filter.toLowerCase();
    return [...ids.values()].filter((m) => !f || m.id.toLowerCase().includes(f)).sort((a, b) => a.id.localeCompare(b.id));
  }, [remote, picked, filter]);

  function toggle(m: ModelInfo) {
    const next = new Map(picked);
    if (next.has(m.id)) next.delete(m.id);
    else next.set(m.id, { modelId: m.id, displayName: typeof m.name === "string" && m.name.trim() ? m.name.trim().slice(0, 200) : null, capabilities: {}, contextLength: m.contextLength ?? null, embeddingDim: null, enabled: true });
    setPicked(next);
  }

  function setCap(id: string, cap: string, v: boolean) {
    const next = new Map(picked);
    const m = next.get(id)!;
    next.set(id, { ...m, capabilities: { ...m.capabilities, [cap]: v } });
    setPicked(next);
  }

  function addManual() {
    const id = manual.trim();
    if (!id) return;
    toggle({ id });
    setManual("");
  }

  async function save() {
    if (!provider) return;
    setSaving(true);
    try {
      await api(`/providers/${provider.id}/models`, { method: "PUT", body: { models: [...picked.values()] } });
      toast.success(`已儲存 ${picked.size} 個模型`);
      await ws.refreshMeta().catch(() => {});
      onOpenChange(false);
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={!!provider} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>模型清單：{provider?.name}</DialogTitle>
          <DialogDescription>勾選要在 EdgeMind 中使用的模型{isLlm ? "，並手動標記能力" : ""}。</DialogDescription>
        </DialogHeader>
        <div className="flex gap-2">
          <div className="relative flex-1">
            <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
            <Input className="pl-8" placeholder="篩選模型" value={filter} onChange={(e) => setFilter(e.target.value)} />
          </div>
          <Button variant="outline" onClick={fetchRemote} disabled={loading}>
            {loading ? <Loader2 className="animate-spin" /> : <RefreshCw />} 重新抓取
          </Button>
        </div>
        {error && <p className="text-sm text-destructive">無法取得模型清單：{error}（仍可手動新增）</p>}
        <div className="max-h-[45vh] divide-y overflow-y-auto rounded-lg border">
          {all.length === 0 && <p className="p-4 text-center text-sm text-muted-foreground">{loading ? "讀取中…" : "沒有模型"}</p>}
          {all.map((m) => {
            const sel = picked.get(m.id);
            return (
              <div key={m.id} className="flex flex-wrap items-center gap-3 px-3 py-2 text-sm">
                <label className="flex min-w-0 flex-1 items-center gap-2">
                  <input type="checkbox" checked={!!sel} onChange={() => toggle(m)} />
                  <span className="truncate font-mono text-xs">{m.id}</span>
                  {m.contextLength ? <span className="text-xs text-muted-foreground">{Math.round(m.contextLength / 1000)}K</span> : null}
                </label>
                {sel && isLlm && (
                  <div className="flex gap-3">
                    {CAPS.map((cap) => (
                      <label key={cap.key} className="flex items-center gap-1 text-xs text-muted-foreground">
                        <input type="checkbox" checked={!!sel.capabilities[cap.key]} onChange={(e) => setCap(m.id, cap.key, e.target.checked)} />
                        {cap.label}
                      </label>
                    ))}
                  </div>
                )}
              </div>
            );
          })}
        </div>
        <div className="flex gap-2">
          <Input placeholder="手動輸入模型 ID" value={manual} onChange={(e) => setManual(e.target.value)} onKeyDown={(e) => e.key === "Enter" && addManual()} />
          <Button variant="secondary" onClick={addManual}>新增</Button>
        </div>
        <DialogFooter>
          <span className="mr-auto self-center text-sm text-muted-foreground">已選 {picked.size} 個</span>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>取消</Button>
          <Button onClick={save} disabled={saving}>{saving && <Loader2 className="animate-spin" />} 儲存</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
