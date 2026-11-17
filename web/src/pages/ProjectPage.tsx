import { useEffect, useState } from "react";
import { Link, useNavigate, useParams, useSearchParams } from "react-router-dom";
import { FolderInput, FolderMinus, Loader2, MessageSquare, MessageSquarePlus, Pin, Play, Trash2 } from "lucide-react";
import { toast } from "sonner";
import { PERMISSION_MODES, PERMISSION_MODE_LABELS, type ConversationDTO, type PermissionMode, type ProjectDTO } from "@edgemind/shared";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { NativeSelect } from "@/components/ui/native-select";
import { Switch } from "@/components/ui/switch";
import { ProjectSkills } from "@/components/Skills";
import { ProjectMcp } from "@/components/Mcp";
import { MemoryList } from "@/components/Memory";
import { Tabs, TabsContent, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { KnowledgeBase } from "@/components/KnowledgeBase";
import { ConfirmDialog } from "@/components/PromptDialog";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { RiskBadge } from "@/components/chat/Parts";
import { FileManager } from "@/components/FileManager";
import { api } from "@/lib/api";
import { modelLabel, useWorkspace } from "@/lib/workspace";

export function ProjectPage() {
  const [search, setSearch] = useSearchParams();
  const tab = search.get("tab") ?? "chats";
  const { id } = useParams();
  const navigate = useNavigate();
  const ws = useWorkspace();
  const [p, setP] = useState<ProjectDTO | null>(null);
  const [convs, setConvs] = useState<ConversationDTO[] | null>(null);
  const [del, setDel] = useState(false);
  const [adding, setAdding] = useState(false);
  const [listError, setListError] = useState<string | null>(null);

  useEffect(() => {
    if (!id) return;
    setP(null);
    setConvs(null);
    api<ProjectDTO>(`/projects/${id}`).then(setP).catch((e) => { toast.error(e.message); navigate("/"); });
  }, [id, navigate]);

  // This project's conversations, newest first (re-read whenever the sidebar list changes: moves, new chats, titles).
  useEffect(() => {
    if (!id) return;
    api<ConversationDTO[]>(`/conversations?projectId=${id}&limit=500`)
      .then((r) => {
        setConvs([...r].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)));
        setListError(null);
      })
      .catch((e) => {
        setConvs([]);
        setListError((e as Error).message);
      });
  }, [id, ws.conversations]);

  async function moveOut(c: ConversationDTO) {
    try {
      await ws.patchConversation(c.id, { projectId: null });
      await Promise.all([ws.refreshConversations(), ws.refreshProjects()]);
      toast.success("已移出專案");
    } catch (e) {
      toast.error((e as Error).message);
    }
  }

  if (!p) return <div className="flex justify-center p-10"><Loader2 className="h-6 w-6 animate-spin text-muted-foreground" /></div>;

  return (
    <div className="mx-auto max-w-4xl space-y-6 p-4 md:p-8">
      <div className="flex flex-wrap items-center gap-3">
        <div className="mr-auto min-w-0">
          <h1 className="truncate text-2xl font-semibold">{p.name}</h1>
          {p.description && <p className="text-sm text-muted-foreground">{p.description}</p>}
        </div>
        {convs?.[0] && (
          <Button variant="outline" onClick={() => navigate(`/c/${convs[0].id}`)} title={convs[0].title ?? undefined}><Play /> 繼續最近的對話</Button>
        )}
        <Button onClick={() => navigate(`/?project=${p.id}`)}><MessageSquarePlus /> 在專案中新對話</Button>
      </div>
      <Tabs value={tab} onValueChange={(v) => setSearch(v === "chats" ? {} : { tab: v }, { replace: true })}>
        <TabsList>
          <TabsTrigger value="chats">對話</TabsTrigger>
          <TabsTrigger value="settings">設定</TabsTrigger>
          <TabsTrigger value="tools">工具</TabsTrigger>
          <TabsTrigger value="skills">Skills</TabsTrigger>
          <TabsTrigger value="mcp">MCP</TabsTrigger>
          <TabsTrigger value="memory">記憶</TabsTrigger>
          <TabsTrigger value="files">檔案</TabsTrigger>
          <TabsTrigger value="kb">知識庫</TabsTrigger>
        </TabsList>
        <TabsContent value="chats">
          <Card>
            <CardHeader className="flex flex-row items-center justify-between gap-2 space-y-0 p-4">
              <CardDescription>這個專案的對話（最新的在最上面）。點一下即可繼續；舊對話可以移進來。</CardDescription>
              <Button size="sm" variant="outline" onClick={() => setAdding(true)}><FolderInput /> 加入現有對話</Button>
            </CardHeader>
            <CardContent className="divide-y border-t p-0" data-testid="project-conversations">
              {convs === null && <div className="p-4 text-sm text-muted-foreground">載入中…</div>}
              {listError && <div role="alert" className="p-4 text-sm text-destructive">無法載入專案對話：{listError}</div>}
              {convs?.length === 0 && !listError && (
                <div className="p-4 text-sm text-muted-foreground">這個專案還沒有對話。按「在專案中新對話」開始，或用「加入現有對話」把之前的對話移進來。</div>
              )}
              {convs?.map((c, i) => (
                <div key={c.id} className="group flex items-center gap-2 px-4 py-3 text-sm hover:bg-accent">
                  <Link to={`/c/${c.id}`} className="flex min-w-0 flex-1 items-center gap-2">
                    {c.pinned ? <Pin className="h-3.5 w-3.5 shrink-0 text-muted-foreground" /> : <MessageSquare className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />}
                    <span className="truncate">{c.title || "未命名對話"}</span>
                    {i === 0 && <span className="shrink-0 rounded bg-muted px-1.5 text-[11px] text-muted-foreground">最近</span>}
                    <span className="ml-auto shrink-0 text-xs text-muted-foreground">{new Date(c.updatedAt).toLocaleString("zh-TW")}</span>
                  </Link>
                  <Button variant="ghost" size="icon" className="h-7 w-7 shrink-0 opacity-60 group-hover:opacity-100" title="移出專案" aria-label={`把「${c.title || "未命名對話"}」移出專案`} onClick={() => moveOut(c)}>
                    <FolderMinus />
                  </Button>
                </div>
              ))}
            </CardContent>
          </Card>
          <AddConversationsDialog open={adding} onOpenChange={setAdding} project={p} />
        </TabsContent>
        <TabsContent value="settings"><ProjectSettings p={p} onSaved={setP} onDelete={() => setDel(true)} /></TabsContent>
        <TabsContent value="tools"><ProjectTools p={p} onSaved={setP} /></TabsContent>
        <TabsContent value="skills"><ProjectSkills p={p} onSaved={setP} /></TabsContent>
        <TabsContent value="mcp"><ProjectMcp p={p} onSaved={setP} /></TabsContent>
        <TabsContent value="memory"><MemoryList projectId={p.id} /></TabsContent>
        <TabsContent value="files"><FileManager projectId={p.id} /></TabsContent>
        <TabsContent value="kb"><KnowledgeBase projectId={p.id} /></TabsContent>
      </Tabs>
      <ConfirmDialog open={del} onOpenChange={setDel} title="刪除專案？" destructive confirmLabel="刪除"
        description="專案設定與專案檔案會被刪除；專案內的對話會保留並移出專案。"
        onConfirm={async () => {
          await api(`/projects/${p.id}`, { method: "DELETE" });
          await Promise.all([ws.refreshProjects(), ws.refreshConversations()]);
          navigate("/");
        }} />
    </div>
  );
}

/** Pick conversations outside every project (newest first, searchable) and move them into `project`. */
function AddConversationsDialog({ open, onOpenChange, project }: { open: boolean; onOpenChange(v: boolean): void; project: ProjectDTO }) {
  const ws = useWorkspace();
  const [list, setList] = useState<ConversationDTO[] | null>(null);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [filter, setFilter] = useState("");
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (!open) return;
    setPicked(new Set());
    setFilter("");
    setList(null);
    api<ConversationDTO[]>("/conversations?projectId=none&limit=500")
      .then((r) => setList([...r].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))))
      .catch((e) => { toast.error((e as Error).message); setList([]); });
  }, [open]);
  const shown = (list ?? []).filter((c) => !filter.trim() || (c.title ?? "").toLowerCase().includes(filter.trim().toLowerCase()));

  async function move() {
    setBusy(true);
    try {
      for (const id of picked) await api(`/conversations/${id}`, { method: "PATCH", body: { projectId: project.id } });
      await Promise.all([ws.refreshConversations(), ws.refreshProjects()]);
      toast.success(`已把 ${picked.size} 個對話移到「${project.name}」`);
      onOpenChange(false);
    } catch (e) {
      toast.error(`移動失敗：${(e as Error).message}`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-h-[90dvh] max-w-lg overflow-y-auto">
        <DialogHeader>
          <DialogTitle>把現有對話加入「{project.name}」</DialogTitle>
          <DialogDescription>只列出不屬於任何專案的對話。移入後它們會出現在專案底下，之後的回覆會使用專案的指示、檔案、知識庫與工具設定。</DialogDescription>
        </DialogHeader>
        <Input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="篩選標題…" aria-label="篩選對話" />
        <div className="max-h-80 divide-y overflow-y-auto rounded-md border">
          {list === null && <div className="p-3 text-sm text-muted-foreground">載入中…</div>}
          {list?.length === 0 && <div className="p-3 text-sm text-muted-foreground">沒有專案以外的對話。</div>}
          {shown.map((c) => (
            <label key={c.id} className="flex cursor-pointer items-center gap-3 px-3 py-2 text-sm hover:bg-accent">
              <input type="checkbox" checked={picked.has(c.id)} onChange={(e) => setPicked((cur) => { const n = new Set(cur); if (e.target.checked) n.add(c.id); else n.delete(c.id); return n; })} />
              <span className="min-w-0 flex-1 truncate">{c.title || "未命名對話"}</span>
              <span className="shrink-0 text-xs text-muted-foreground">{new Date(c.updatedAt).toLocaleDateString("zh-TW")}</span>
            </label>
          ))}
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>取消</Button>
          <Button onClick={move} disabled={busy || !picked.size}>{busy && <Loader2 className="animate-spin" />} 移入 {picked.size || ""} 個對話</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ProjectSettings({ p, onSaved, onDelete }: { p: ProjectDTO; onSaved(p: ProjectDTO): void; onDelete(): void }) {
  const ws = useWorkspace();
  const [name, setName] = useState(p.name);
  const [description, setDescription] = useState(p.description ?? "");
  const [instructions, setInstructions] = useState(p.instructions ?? "");
  const [model, setModel] = useState(p.defaultModelId ?? "");
  const [mode, setMode] = useState<string>(p.permissionMode ?? "");
  const [busy, setBusy] = useState(false);

  async function save() {
    setBusy(true);
    try {
      const r = await api<ProjectDTO>(`/projects/${p.id}`, {
        method: "PATCH",
        body: { name, description: description || null, instructions: instructions || null, defaultModelId: model || null, permissionMode: (mode || null) as PermissionMode | null },
      });
      onSaved(r);
      await ws.refreshProjects();
      toast.success("已儲存");
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <CardHeader><CardTitle>專案設定</CardTitle><CardDescription>專案指示會加在每次對話的系統提示中；預設值可在個別對話覆蓋。</CardDescription></CardHeader>
      <CardContent className="space-y-4">
        <div className="space-y-1.5"><Label>名稱</Label><Input value={name} onChange={(e) => setName(e.target.value)} /></div>
        <div className="space-y-1.5"><Label>說明</Label><Input value={description} onChange={(e) => setDescription(e.target.value)} placeholder="（選填）" /></div>
        <div className="space-y-1.5">
          <Label>專案指示（System Prompt）</Label>
          <textarea value={instructions} onChange={(e) => setInstructions(e.target.value)} rows={8}
            className="w-full rounded-md border bg-background px-3 py-2 text-sm" placeholder="例如：你是這個專案的技術顧問，回答一律附上程式碼範例。" />
        </div>
        <div className="grid gap-4 sm:grid-cols-2">
          <div className="space-y-1.5">
            <Label>預設模型</Label>
            <NativeSelect value={model} onChange={(e) => setModel(e.target.value)}>
              <option value="">（使用全域預設）</option>
              {ws.models.map((m) => <option key={m.id} value={m.id}>{m.providerName} · {modelLabel(m)}</option>)}
            </NativeSelect>
          </div>
          <div className="space-y-1.5">
            <Label>預設權限模式</Label>
            <NativeSelect value={mode} onChange={(e) => setMode(e.target.value)}>
              <option value="">（繼承全域設定）</option>
              {PERMISSION_MODES.map((m) => <option key={m} value={m}>{PERMISSION_MODE_LABELS[m]}</option>)}
            </NativeSelect>
          </div>
        </div>
        <div className="flex justify-between">
          <Button variant="outline" className="text-destructive" onClick={onDelete}><Trash2 /> 刪除專案</Button>
          <Button onClick={save} disabled={busy || !name.trim()}>儲存</Button>
        </div>
      </CardContent>
    </Card>
  );
}

function ProjectTools({ p, onSaved }: { p: ProjectDTO; onSaved(p: ProjectDTO): void }) {
  const ws = useWorkspace();
  const all = p.enabledTools === null;
  const enabled = new Set(p.enabledTools ?? ws.tools.map((t) => t.name));
  const httpOff = !all && ws.tools.some((t) => t.name === "http_request") && !enabled.has("http_request");

  async function save(enabledTools: string[] | null) {
    try {
      onSaved(await api<ProjectDTO>(`/projects/${p.id}`, { method: "PATCH", body: { enabledTools } }));
      await ws.refreshProjects();
    } catch (e) {
      toast.error((e as Error).message);
    }
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>啟用的工具</CardTitle>
        <CardDescription>未啟用的工具不會提供給模型。權限模式仍然決定已啟用工具是否需要你的批准。</CardDescription>
      </CardHeader>
      <CardContent className="space-y-3">
        <label className="flex items-center gap-3 text-sm font-medium">
          {/* Turning "all" off snapshots the current tool list: never save it before the list has loaded (would disable every tool). */}
          <Switch checked={all} disabled={!ws.tools.length} onCheckedChange={(v) => save(v ? null : ws.tools.map((t) => t.name))} />
          啟用全部工具（包含之後新增的工具）
        </label>
        {!all && <p className="text-xs text-muted-foreground">只啟用勾選的工具：之後新增的工具不會自動啟用。</p>}
        {httpOff && (
          <p className="rounded-md border border-amber-500/40 bg-amber-500/10 p-2 text-xs">
            http_request 未啟用：這個專案的對話無法使用「設定 → 密鑰」中的密鑰（例如 e2b-sandbox、self-hosted-runner Skill）。需要時請勾選 http_request。
          </p>
        )}
        <div className="divide-y rounded-md border">
          {ws.tools.map((t) => (
            <label key={t.name} className="flex items-start gap-3 p-3 text-sm">
              <input type="checkbox" className="mt-1" disabled={all} checked={all || enabled.has(t.name)}
                onChange={(e) => {
                  const next = new Set(enabled);
                  if (e.target.checked) next.add(t.name);
                  else next.delete(t.name);
                  save([...next]);
                }} />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2"><span className="font-mono text-[13px]">{t.name}</span><RiskBadge risk={t.risk} /></div>
                <div className="text-xs text-muted-foreground">{t.description}</div>
              </div>
            </label>
          ))}
        </div>
      </CardContent>
    </Card>
  );
}
