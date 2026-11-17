import { useEffect, useMemo, useState } from "react";
import { Link, useLocation, useNavigate, useParams } from "react-router-dom";
import { AlertTriangle, Archive, ArchiveRestore, BarChart3, BookOpen, CalendarClock, ChevronDown, ChevronRight, Download, FileText, FolderInput, FolderMinus, FolderOpen, FolderPlus, LogOut, MessageSquarePlus, MoreHorizontal, Pencil, Pin, PinOff, Plus, Search, Settings, SlidersHorizontal, Trash2, X } from "lucide-react";
import { toast } from "sonner";
import type { ConversationDTO, ProjectDTO, SpendStatus } from "@edgemind/shared";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { NativeSelect } from "@/components/ui/native-select";
import { ThemeToggle } from "@/components/ThemeToggle";
import { ConfirmDialog, PromptDialog } from "@/components/PromptDialog";
import { api } from "@/lib/api";
import { useInstallPrompt } from "@/lib/pwa";
import { useWorkspace } from "@/lib/workspace";
import { cn } from "@/lib/utils";

export function Sidebar({ onLogout, onNavigate }: { onLogout(): void; onNavigate?(): void }) {
  const ws = useWorkspace();
  const navigate = useNavigate();
  const { id: activeId } = useParams();
  const [q, setQ] = useState("");
  const [results, setResults] = useState<ConversationDTO[] | null>(null);
  const [showArchived, setShowArchived] = useState(false);
  const [archived, setArchived] = useState<ConversationDTO[]>([]);
  const [newProject, setNewProject] = useState(false);

  useEffect(() => {
    if (!q.trim()) return setResults(null);
    const t = setTimeout(() => {
      api<ConversationDTO[]>(`/conversations?archived=all&q=${encodeURIComponent(q.trim())}`).then(setResults).catch(() => setResults([]));
    }, 250);
    return () => clearTimeout(t);
  }, [q]);

  useEffect(() => {
    if (showArchived) api<ConversationDTO[]>("/conversations?archived=1").then(setArchived).catch(() => {});
  }, [showArchived, ws.conversations]);

  // Project conversations live under their project; 最近對話 / 已釘選 show only conversations outside every project.
  const loose = useMemo(() => ws.conversations.filter((c) => !c.projectId), [ws.conversations]);
  const pinned = useMemo(() => loose.filter((c) => c.pinned), [loose]);
  const recent = useMemo(() => loose.filter((c) => !c.pinned), [loose]);
  const byProject = useMemo(() => {
    const m = new Map<string, ConversationDTO[]>();
    for (const c of ws.conversations) if (c.projectId) (m.get(c.projectId) ?? m.set(c.projectId, []).get(c.projectId)!).push(c);
    for (const list of m.values()) list.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)); // newest first
    return m;
  }, [ws.conversations]);

  const [expanded, setExpanded] = useState<Set<string>>(() => {
    try {
      return new Set(JSON.parse(localStorage.getItem("em:expandedProjects") ?? "[]"));
    } catch {
      return new Set();
    }
  });
  const setOpen = (id: string, open: boolean) =>
    setExpanded((cur) => {
      if (cur.has(id) === open) return cur;
      const n = new Set(cur);
      if (open) n.add(id);
      else n.delete(id);
      localStorage.setItem("em:expandedProjects", JSON.stringify([...n]));
      return n;
    });
  // The open conversation's project (or the open project page) is always expanded, so its chat is visible in place.
  const { pathname } = useLocation();
  const activeProject = ws.conversations.find((c) => c.id === activeId)?.projectId ?? (/^\/p\/([0-9a-f-]{36})/.exec(pathname)?.[1] ?? null);
  useEffect(() => {
    // a conversation just moved into a project: show it there
    const onMoved = (e: Event) => setOpen((e as CustomEvent<string>).detail, true);
    window.addEventListener("em:expand-project", onMoved);
    return () => window.removeEventListener("em:expand-project", onMoved);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    if (activeProject) setOpen(activeProject, true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeProject]);

  /** Opening a project continues its most recent conversation; a project without conversations opens its page. */
  function openProject(p: ProjectDTO) {
    setOpen(p.id, true);
    const latest = byProject.get(p.id)?.[0];
    navigate(latest ? `/c/${latest.id}` : `/p/${p.id}`);
    onNavigate?.();
  }

  async function logout() {
    await api("/auth/logout", { method: "POST" }).catch(() => {});
    onLogout();
  }

  const item = (c: ConversationDTO) => <ConversationItem key={c.id} c={c} active={c.id === activeId} onNavigate={onNavigate} />;

  return (
    <div className="flex h-full flex-col gap-2 p-3">
      <div className="flex items-center justify-between px-1">
        <Link to="/" onClick={onNavigate} className="flex items-center gap-2 font-semibold">
          <img src="/favicon.svg" alt="" className="h-6 w-6" /> EdgeMind
        </Link>
        <Button size="icon" variant="ghost" title="新對話" aria-label="新對話" onClick={() => { navigate("/"); onNavigate?.(); }}>
          <Plus />
        </Button>
      </div>
      <div className="relative">
        <Search className="absolute left-2.5 top-2.5 h-4 w-4 text-muted-foreground" />
        <Input value={q} onChange={(e) => setQ(e.target.value)} placeholder="搜尋對話…" className="pl-8 pr-8" />
        {q && (
          <button className="absolute right-2 top-2.5 text-muted-foreground" onClick={() => setQ("")} aria-label="清除搜尋">
            <X className="h-4 w-4" />
          </button>
        )}
      </div>

      <div className="-mx-1 min-h-0 flex-1 overflow-y-auto px-1">
        {results ? (
          <Section title={`搜尋結果（${results.length}）`}>
            {results.map((c) => (
              <Link key={c.id} to={`/c/${c.id}`} onClick={onNavigate} className="block rounded-md px-2 py-1.5 text-sm hover:bg-accent">
                <div className="truncate font-medium">{c.title || "未命名對話"}</div>
                {c.snippet && <div className="line-clamp-2 text-xs text-muted-foreground">{c.snippet}</div>}
              </Link>
            ))}
            {!results.length && <p className="px-2 py-1 text-xs text-muted-foreground">找不到符合的對話</p>}
          </Section>
        ) : (
          <>
            <Section
              title="專案"
              action={<button className="text-muted-foreground hover:text-foreground" title="新增專案" aria-label="新增專案" onClick={() => setNewProject(true)}><FolderPlus className="h-4 w-4" /></button>}
            >
              {ws.projects.map((p) => (
                <ProjectItem key={p.id} p={p} convs={byProject.get(p.id) ?? []} open={expanded.has(p.id)} activeId={activeId}
                  pageActive={pathname === `/p/${p.id}`} onToggle={() => setOpen(p.id, !expanded.has(p.id))} onOpen={() => openProject(p)} onNavigate={onNavigate} />
              ))}
              {!ws.projects.length && <p className="px-2 py-1 text-xs text-muted-foreground">尚無專案</p>}
            </Section>
            {pinned.length > 0 && <Section title="已釘選">{pinned.map(item)}</Section>}
            <Section title="最近對話">
              {recent.map(item)}
              {!recent.length && <p className="px-2 py-1 text-xs text-muted-foreground">還沒有對話</p>}
            </Section>
            <button className="mt-2 px-2 text-xs text-muted-foreground hover:text-foreground" onClick={() => setShowArchived((v) => !v)}>
              {showArchived ? "隱藏已封存" : "顯示已封存"}
            </button>
            {showArchived && <Section title="已封存">{archived.map(item)}{!archived.length && <p className="px-2 py-1 text-xs text-muted-foreground">沒有封存的對話</p>}</Section>}
          </>
        )}
      </div>

      <div className="border-t pt-2">
        <Button asChild variant="ghost" size="sm" className="w-full justify-start">
          <Link to="/schedules" onClick={onNavigate}><CalendarClock /> 排程</Link>
        </Button>
        <Button asChild variant="ghost" size="sm" className="w-full justify-start">
          <Link to="/usage" onClick={onNavigate}><BarChart3 /> 用量</Link>
        </Button>
        <InstallButton />
        <SpendNotice onNavigate={onNavigate} />
      </div>
      <div className="flex items-center gap-1 pt-1">
        <Button asChild variant="ghost" size="sm" className="flex-1 justify-start">
          <Link to="/settings" onClick={onNavigate}><Settings /> 設定</Link>
        </Button>
        <ThemeToggle />
        <Button variant="ghost" size="icon" onClick={logout} title="登出" aria-label="登出"><LogOut /></Button>
      </div>

      <PromptDialog
        open={newProject}
        onOpenChange={setNewProject}
        title="新增專案"
        placeholder="專案名稱"
        confirmLabel="建立"
        onSubmit={async (name) => {
          const p = await api<{ id: string }>("/projects", { method: "POST", body: { name } });
          await ws.refreshProjects();
          navigate(`/p/${p.id}`);
          onNavigate?.();
        }}
      />
    </div>
  );
}

/**
 * A project in the sidebar: click = continue its most recent conversation (or its page when it has none); the chevron
 * expands its conversations (newest first) with an explicit 「在專案中新對話」 and a link to the project page.
 */
function ProjectItem({ p, convs, open, activeId, pageActive, onToggle, onOpen, onNavigate }: {
  p: ProjectDTO; convs: ConversationDTO[]; open: boolean; activeId?: string; pageActive: boolean; onToggle(): void; onOpen(): void; onNavigate?(): void;
}) {
  const navigate = useNavigate();
  const [all, setAll] = useState(false);
  const shown = all ? convs : convs.slice(0, 8);
  const inProject = convs.some((c) => c.id === activeId);
  return (
    <div data-testid="sidebar-project" data-project-id={p.id}>
      <div className={cn("group flex items-center rounded-md hover:bg-accent", (pageActive || (inProject && !open)) && "bg-accent")}>
        <button className="rounded p-1 pl-1.5 text-muted-foreground hover:text-foreground" onClick={onToggle} aria-label={open ? `收合 ${p.name}` : `展開 ${p.name}`} aria-expanded={open}>
          {open ? <ChevronDown className="h-3.5 w-3.5" /> : <ChevronRight className="h-3.5 w-3.5" />}
        </button>
        <button className="flex min-w-0 flex-1 items-center gap-2 py-1.5 pr-1 text-left text-sm" onClick={onOpen} title={convs.length ? `繼續「${convs[0].title || "未命名對話"}」` : "開啟專案"}>
          <FolderOpen className="h-4 w-4 shrink-0 text-muted-foreground" />
          <span className={cn("truncate", pageActive && "font-medium")}>{p.name}</span>
        </button>
        <span className="text-xs text-muted-foreground">{convs.length || ""}</span>
        <Link to={`/p/${p.id}`} onClick={onNavigate} className="mr-1 rounded p-1 text-muted-foreground hover:text-foreground" title="專案首頁（對話、檔案、知識庫與設定）" aria-label={`${p.name} 專案首頁`}>
          <SlidersHorizontal className="h-3.5 w-3.5" />
        </Link>
      </div>
      {open && (
        <div className="ml-4 space-y-0.5 border-l pl-1.5">
          <button className="flex w-full items-center gap-1.5 rounded-md px-2 py-1 text-xs text-muted-foreground hover:bg-accent hover:text-foreground"
            onClick={() => { navigate(`/?project=${p.id}`); onNavigate?.(); }}>
            <MessageSquarePlus className="h-3.5 w-3.5" /> 在專案中新對話
          </button>
          <div className="flex gap-1">
            <Link to={`/p/${p.id}?tab=files`} onClick={onNavigate} className="flex flex-1 items-center gap-1.5 rounded-md px-2 py-1 text-xs text-muted-foreground hover:bg-accent hover:text-foreground">
              <FileText className="h-3.5 w-3.5" /> 檔案
            </Link>
            <Link to={`/p/${p.id}?tab=kb`} onClick={onNavigate} className="flex flex-1 items-center gap-1.5 rounded-md px-2 py-1 text-xs text-muted-foreground hover:bg-accent hover:text-foreground">
              <BookOpen className="h-3.5 w-3.5" /> 知識庫
            </Link>
          </div>
          {shown.map((c) => <ConversationItem key={c.id} c={c} active={c.id === activeId} onNavigate={onNavigate} />)}
          {convs.length > 8 && (
            <button className="px-2 py-0.5 text-xs text-muted-foreground hover:text-foreground" onClick={() => setAll((v) => !v)}>{all ? "顯示較少" : `顯示全部 ${convs.length} 個對話`}</button>
          )}
          {!convs.length && <p className="px-2 py-1 text-xs text-muted-foreground">還沒有對話；可從對話的「⋯ → 移到專案」把舊對話移進來。</p>}
        </div>
      )}
    </div>
  );
}

function Section({ title, action, children }: { title: string; action?: React.ReactNode; children: React.ReactNode }) {
  return (
    <div className="mt-3" data-section={title}>
      <div className="mb-1 flex items-center justify-between px-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">
        <span>{title}</span>
        {action}
      </div>
      <div className="space-y-0.5">{children}</div>
    </div>
  );
}

function ConversationItem({ c, active, onNavigate }: { c: ConversationDTO; active: boolean; onNavigate?(): void }) {
  const ws = useWorkspace();
  const navigate = useNavigate();
  const [rename, setRename] = useState(false);
  const [del, setDel] = useState(false);
  const [move, setMove] = useState(false);
  const [target, setTarget] = useState<string>(c.projectId ?? "");

  const act = async (fn: () => Promise<unknown>, ok?: string) => {
    try {
      await fn();
      await ws.refreshConversations();
      await ws.refreshProjects();
      if (ok) toast.success(ok);
    } catch (e) {
      toast.error((e as Error).message);
    }
  };

  return (
    <div className={cn("group flex items-center rounded-md hover:bg-accent", active && "bg-accent")}>
      <Link to={`/c/${c.id}`} onClick={onNavigate} className="flex min-w-0 flex-1 items-center gap-1.5 px-2 py-1.5 text-sm">
        {c.pinned && <Pin className="h-3 w-3 shrink-0 text-muted-foreground" />}
        <span className={cn("truncate", active && "font-medium")}>{c.title || "未命名對話"}</span>
      </Link>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button className="mr-1 rounded p-1 text-muted-foreground opacity-0 hover:text-foreground focus:opacity-100 group-hover:opacity-100" aria-label="對話選項">
            <MoreHorizontal className="h-4 w-4" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onSelect={() => setRename(true)}><Pencil /> 重新命名</DropdownMenuItem>
          <DropdownMenuItem onSelect={() => act(() => ws.patchConversation(c.id, { pinned: !c.pinned }))}>
            {c.pinned ? <><PinOff /> 取消釘選</> : <><Pin /> 釘選</>}
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={() => { setTarget(c.projectId ?? ""); setMove(true); }}><FolderInput /> {c.projectId ? "移到其他專案…" : "移到專案…"}</DropdownMenuItem>
          {c.projectId && (
            <DropdownMenuItem onSelect={() => act(() => ws.patchConversation(c.id, { projectId: null }), "已移出專案")}><FolderMinus /> 移出專案</DropdownMenuItem>
          )}
          <DropdownMenuItem onSelect={() => act(() => ws.patchConversation(c.id, { archived: !c.archived }), c.archived ? "已取消封存" : "已封存")}>
            {c.archived ? <><ArchiveRestore /> 取消封存</> : <><Archive /> 封存</>}
          </DropdownMenuItem>
          <DropdownMenuItem className="text-destructive" onSelect={() => setDel(true)}><Trash2 /> 刪除</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <PromptDialog open={rename} onOpenChange={setRename} title="重新命名對話" initial={c.title ?? ""} confirmLabel="儲存"
        onSubmit={(title) => act(() => ws.patchConversation(c.id, { title }))} />
      <ConfirmDialog open={del} onOpenChange={setDel} title="刪除對話？" description="此對話的所有訊息都會被永久刪除，無法復原。" confirmLabel="刪除" destructive
        onConfirm={() => act(async () => {
          await api(`/conversations/${c.id}`, { method: "DELETE" });
          if (active) navigate("/");
        }, "已刪除")} />
      <Dialog open={move} onOpenChange={setMove}>
        <DialogContent>
          <DialogHeader><DialogTitle>移到專案</DialogTitle></DialogHeader>
          <p className="text-sm text-muted-foreground">「{c.title || "未命名對話"}」會出現在所選專案底下，之後的回覆會使用該專案的指示、檔案、知識庫與工具設定。</p>
          <NativeSelect value={target} onChange={(e) => setTarget(e.target.value)} aria-label="目標專案">
            <option value="">（不屬於任何專案）</option>
            {ws.projects.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </NativeSelect>
          <DialogFooter>
            <Button variant="ghost" onClick={() => setMove(false)}>取消</Button>
            <Button onClick={() => act(async () => {
              await ws.patchConversation(c.id, { projectId: target || null });
              setMove(false);
              if (target) window.dispatchEvent(new CustomEvent("em:expand-project", { detail: target }));
            }, target ? "已移到專案" : "已移出專案")}>移動</Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  );
}

/** Spend-cap warning (≥ warn ratio) or block, polled every 5 minutes. */
function SpendNotice({ onNavigate }: { onNavigate?: () => void }) {
  const [s, setS] = useState<SpendStatus | null>(null);
  useEffect(() => {
    const load = () => api<SpendStatus>("/usage/status").then(setS).catch(() => {});
    load();
    const t = setInterval(load, 5 * 60_000);
    return () => clearInterval(t);
  }, []);
  if (!s?.message) return null;
  const blocked = s.daily === "blocked" || s.monthly === "blocked";
  return (
    <Link to="/usage" onClick={onNavigate} className={`mx-2 mt-1 flex items-start gap-1.5 rounded-md border px-2 py-1.5 text-xs ${blocked ? "border-destructive text-destructive" : "border-amber-500 text-amber-700 dark:text-amber-400"}`}>
      <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" /> <span>{s.message}</span>
    </Link>
  );
}

/** 「安裝 App」: shown only while the browser offers PWA installation. */
function InstallButton() {
  const { canInstall, install } = useInstallPrompt();
  if (!canInstall) return null;
  return (
    <Button variant="ghost" size="sm" className="w-full justify-start" onClick={install}>
      <Download /> 安裝 App
    </Button>
  );
}
