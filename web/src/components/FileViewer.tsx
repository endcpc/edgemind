import { useEffect, useMemo, useState } from "react";
import { Download, Eye, Loader2, Pencil, Save } from "lucide-react";
import { toast } from "sonner";
import type { FileDTO } from "@edgemind/shared";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Markdown } from "@/components/chat/Parts";
import { api } from "@/lib/api";

const TEXT_EXT = /\.(txt|md|markdown|csv|tsv|json|jsonl|ya?ml|toml|xml|html?|css|scss|js|jsx|ts|tsx|mjs|cjs|py|rb|go|rs|java|kt|swift|c|cc|cpp|h|hpp|cs|php|sh|bash|sql|ini|cfg|conf|log|vue|svelte|tex|r|lua|dart|scala|graphql|proto|svg)$/i;

/** Roughly mirrors the server's isTextMime: files that can be viewed / edited as text in the browser. */
export function isTextFile(mime: string | null | undefined, path: string): boolean {
  if (mime && (/^text\//.test(mime) || /(json|xml|yaml|javascript|typescript|csv|sql|x-sh|toml|svg)/.test(mime))) return true;
  return TEXT_EXT.test(path);
}
const isImage = (mime: string | null | undefined, path: string) => /^image\//.test(mime ?? "") || /\.(png|jpe?g|gif|webp|bmp|avif)$/i.test(path);
const isPdf = (mime: string | null | undefined, path: string) => mime === "application/pdf" || /\.pdf$/i.test(path);
const isMarkdown = (path: string) => /\.(md|markdown)$/i.test(path);

/** Preview a project file; text files (≤ 2 MB) can be edited and saved as a new version. */
export function FileViewer({ file, onClose, onSaved, onDownload }: { file: FileDTO | null; onClose(): void; onSaved(): void; onDownload(f: FileDTO): void }) {
  const [text, setText] = useState<string | null>(null);
  const [orig, setOrig] = useState("");
  const [version, setVersion] = useState<number | null>(null);
  const [url, setUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [mode, setMode] = useState<"edit" | "preview">("edit");
  const [saving, setSaving] = useState(false);

  const kind = useMemo(() => {
    if (!file) return null;
    if (isTextFile(file.mime, file.path)) return "text";
    if (isImage(file.mime, file.path)) return "image";
    if (isPdf(file.mime, file.path)) return "pdf";
    return "other";
  }, [file]);

  useEffect(() => {
    setText(null);
    setUrl(null);
    setError(null);
    setVersion(null);
    setMode(file && isMarkdown(file.path) && file.size > 0 ? "preview" : "edit");
    if (!file) return;
    if (kind === "text") {
      api<{ text: string; version: number }>(`/files/${file.id}/content`)
        .then((r) => {
          setText(r.text);
          setOrig(r.text);
          setVersion(r.version);
        })
        .catch((e) => setError((e as Error).message));
    } else if (kind === "image" || kind === "pdf") {
      api<{ url: string }>(`/files/${file.id}/view`).then((r) => setUrl(r.url)).catch((e) => setError((e as Error).message));
    }
  }, [file, kind]);

  const dirty = text !== null && text !== orig;

  async function save() {
    if (!file || text === null || !dirty) return;
    setSaving(true);
    try {
      const r = await api<FileDTO>(`/files/${file.id}/content`, { method: "PUT", body: { text, baseVersion: version } });
      setOrig(text);
      setVersion(r.version);
      toast.success(`已儲存為 v${r.version}`);
      onSaved();
    } catch (e) {
      toast.error((e as Error).message);
    } finally {
      setSaving(false);
    }
  }

  function close() {
    if (dirty && !window.confirm("有尚未儲存的修改，確定要關閉嗎？")) return;
    onClose();
  }

  const spinner = <div className="flex justify-center py-10"><Loader2 className="h-5 w-5 animate-spin text-muted-foreground" /></div>;

  return (
    <Dialog open={!!file} onOpenChange={(v) => !v && close()}>
      <DialogContent className="flex h-[85vh] max-w-5xl flex-col">
        <DialogHeader>
          <DialogTitle className="truncate pr-8" title={file?.path}>
            {file?.path}
            {version !== null && <span className="ml-2 text-sm font-normal text-muted-foreground">v{version}{dirty ? " · 未儲存" : ""}</span>}
          </DialogTitle>
        </DialogHeader>
        <div className="flex flex-wrap items-center gap-2">
          {kind === "text" && file && isMarkdown(file.path) && (
            <>
              <Button size="sm" variant={mode === "preview" ? "secondary" : "ghost"} onClick={() => setMode("preview")}><Eye /> 預覽</Button>
              <Button size="sm" variant={mode === "edit" ? "secondary" : "ghost"} onClick={() => setMode("edit")}><Pencil /> 編輯</Button>
            </>
          )}
          <div className="ml-auto flex gap-2">
            {file && <Button size="sm" variant="outline" onClick={() => onDownload(file)}><Download /> 下載</Button>}
            {kind === "text" && <Button size="sm" onClick={save} disabled={!dirty || saving}>{saving ? <Loader2 className="animate-spin" /> : <Save />} 儲存</Button>}
          </div>
        </div>
        <div className="min-h-0 flex-1 overflow-auto rounded-md border">
          {error ? (
            <p className="p-4 text-sm text-destructive">{error}</p>
          ) : kind === "text" ? (
            text === null ? spinner : mode === "preview" ? (
              <div className="p-4 text-sm"><Markdown text={text} /></div>
            ) : (
              <textarea
                aria-label="檔案內容"
                className="h-full min-h-[50vh] w-full resize-none bg-transparent p-3 font-mono text-sm outline-none"
                value={text}
                spellCheck={false}
                onChange={(e) => setText(e.target.value)}
                onKeyDown={(e) => {
                  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
                    e.preventDefault();
                    save();
                  } else if (e.key === "Tab" && !e.shiftKey) {
                    e.preventDefault();
                    const t = e.currentTarget;
                    const a = t.selectionStart;
                    const b = t.selectionEnd;
                    setText(t.value.slice(0, a) + "  " + t.value.slice(b));
                    requestAnimationFrame(() => {
                      t.selectionStart = t.selectionEnd = a + 2;
                    });
                  }
                }}
              />
            )
          ) : kind === "image" ? (
            url ? <div className="flex justify-center p-4"><img src={url} alt={file?.path} className="max-h-[70vh] max-w-full object-contain" /></div> : spinner
          ) : kind === "pdf" ? (
            url ? <iframe src={url} title={file?.path} className="h-full min-h-[60vh] w-full" /> : spinner
          ) : (
            <p className="p-4 text-sm text-muted-foreground">這種檔案無法線上預覽，請下載後開啟。</p>
          )}
        </div>
        {kind === "text" && <p className="text-xs text-muted-foreground">Ctrl／⌘ + S 儲存；每次儲存都會保留舊版本，可在「版本紀錄」還原。</p>}
      </DialogContent>
    </Dialog>
  );
}
