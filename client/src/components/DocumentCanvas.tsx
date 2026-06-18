/**
 * DocumentCanvas — collapsible right-side document panel for the MAIN chat.
 *
 * One Markdown document per conversation, persisted server-side (no
 * localStorage/sessionStorage/cookies). Supports title editing, content
 * editing with an Edit/Preview toggle, save status, collapse/hide, and
 * download as a .md file. When the agent edits the document via its tools,
 * the parent bumps `refreshKey` so the panel re-fetches the latest content.
 */
import { useState, useEffect, useRef, useCallback } from "react";
import { useQuery } from "@tanstack/react-query";
import { apiRequest, queryClient } from "@/lib/queryClient";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import rehypeHighlight from "rehype-highlight";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { FileText, Download, X, Eye, Pencil, Loader2, Check } from "lucide-react";

interface DocumentDto {
  id: number;
  conversationId: number;
  title: string;
  content: string;
  format: string;
  updatedAt: string;
}

interface DocumentCanvasProps {
  conversationId: number;
  /** Bump to force a re-fetch (e.g. after the agent edits the doc). */
  refreshKey?: number;
  onClose: () => void;
}

type SaveState = "idle" | "dirty" | "saving" | "saved" | "error";

export function DocumentCanvas({ conversationId, refreshKey = 0, onClose }: DocumentCanvasProps) {
  const [mode, setMode] = useState<"edit" | "preview">("preview");
  const [title, setTitle] = useState("Untitled");
  const [content, setContent] = useState("");
  const [saveState, setSaveState] = useState<SaveState>("idle");
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastSaved = useRef<{ title: string; content: string }>({ title: "", content: "" });

  const queryKey = ["/api/conversations", String(conversationId), "document"];
  const { data, isLoading } = useQuery<DocumentDto | null>({
    queryKey: [...queryKey, refreshKey],
    queryFn: async () => {
      const res = await apiRequest("GET", `/api/conversations/${conversationId}/document`);
      return (await res.json()) as DocumentDto | null;
    },
  });

  // Sync server state into local editor state (only when not mid-edit to avoid
  // clobbering the user's keystrokes; a server refresh always wins on load).
  useEffect(() => {
    const t = data?.title ?? "Untitled";
    const c = data?.content ?? "";
    setTitle(t);
    setContent(c);
    lastSaved.current = { title: t, content: c };
    setSaveState("idle");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [data?.id, refreshKey, conversationId]);

  const save = useCallback(async (nextTitle: string, nextContent: string) => {
    if (nextTitle === lastSaved.current.title && nextContent === lastSaved.current.content) {
      setSaveState("idle");
      return;
    }
    setSaveState("saving");
    try {
      await apiRequest("PUT", `/api/conversations/${conversationId}/document`, {
        title: nextTitle,
        content: nextContent,
        format: "markdown",
      });
      lastSaved.current = { title: nextTitle, content: nextContent };
      setSaveState("saved");
      queryClient.invalidateQueries({ queryKey });
      setTimeout(() => setSaveState(s => (s === "saved" ? "idle" : s)), 1500);
    } catch {
      setSaveState("error");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversationId]);

  const scheduleSave = useCallback((nextTitle: string, nextContent: string) => {
    setSaveState("dirty");
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => save(nextTitle, nextContent), 800);
  }, [save]);

  useEffect(() => () => { if (saveTimer.current) clearTimeout(saveTimer.current); }, []);

  const handleTitleChange = (v: string) => { setTitle(v); scheduleSave(v, content); };
  const handleContentChange = (v: string) => { setContent(v); scheduleSave(title, v); };

  const handleDownload = () => {
    window.open(`/api/conversations/${conversationId}/document/download`, "_blank");
  };

  const saveLabel: Record<SaveState, string> = {
    idle: "Saved",
    dirty: "Unsaved…",
    saving: "Saving…",
    saved: "Saved",
    error: "Save failed",
  };

  return (
    <div
      className="flex flex-col h-full border-l border-border bg-card/30 w-full sm:w-[340px] md:w-[400px] lg:w-[460px] shrink-0"
      data-testid="document-canvas"
    >
      {/* Header */}
      <div className="flex items-center gap-2 px-3 py-2 border-b border-border bg-card/50 shrink-0">
        <FileText className="w-4 h-4 text-primary shrink-0" />
        <input
          value={title}
          onChange={(e) => handleTitleChange(e.target.value)}
          placeholder="Untitled"
          className="flex-1 bg-transparent border-none outline-none text-sm font-medium text-foreground min-w-0"
          data-testid="document-title-input"
        />
        <div className="flex items-center gap-1 shrink-0">
          <div className="flex items-center gap-1 text-[10px] text-muted-foreground mr-1" data-testid="document-save-state">
            {saveState === "saving" && <Loader2 className="w-3 h-3 animate-spin" />}
            {(saveState === "saved" || saveState === "idle") && <Check className="w-3 h-3 text-green-500" />}
            <span className={saveState === "error" ? "text-red-400" : ""}>{saveLabel[saveState]}</span>
          </div>
          <Button
            variant="ghost" size="sm"
            className="h-7 px-2"
            onClick={() => setMode(m => (m === "edit" ? "preview" : "edit"))}
            data-testid="document-mode-toggle"
            title={mode === "edit" ? "Preview" : "Edit"}
          >
            {mode === "edit" ? <Eye className="w-3.5 h-3.5" /> : <Pencil className="w-3.5 h-3.5" />}
          </Button>
          <Button
            variant="ghost" size="sm" className="h-7 px-2"
            onClick={handleDownload} data-testid="document-download"
            title="Download as Markdown"
          >
            <Download className="w-3.5 h-3.5" />
          </Button>
          <Button
            variant="ghost" size="sm" className="h-7 px-2"
            onClick={onClose} data-testid="document-close"
            title="Hide document"
          >
            <X className="w-3.5 h-3.5" />
          </Button>
        </div>
      </div>

      {/* Body */}
      <div className="flex-1 min-h-0 overflow-auto">
        {isLoading ? (
          <div className="flex items-center justify-center h-full text-muted-foreground text-sm">
            <Loader2 className="w-4 h-4 animate-spin mr-2" /> Loading…
          </div>
        ) : mode === "edit" ? (
          <Textarea
            value={content}
            onChange={(e) => handleContentChange(e.target.value)}
            placeholder="Write your document in Markdown…"
            className="w-full h-full min-h-full resize-none border-none rounded-none font-mono text-sm leading-relaxed focus-visible:ring-0"
            data-testid="document-editor"
          />
        ) : content.trim().length === 0 ? (
          <div className="flex flex-col items-center justify-center h-full text-muted-foreground text-sm gap-2 p-6 text-center">
            <FileText className="w-8 h-8 opacity-40" />
            <p>This conversation's document is empty.</p>
            <Button variant="outline" size="sm" onClick={() => setMode("edit")} data-testid="document-start-writing">
              Start writing
            </Button>
            <p className="text-xs opacity-70">…or ask the agent to "write this up in the doc".</p>
          </div>
        ) : (
          <div className="prose prose-invert prose-sm max-w-none p-4" data-testid="document-preview">
            <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[rehypeHighlight]}>
              {content}
            </ReactMarkdown>
          </div>
        )}
      </div>
    </div>
  );
}
