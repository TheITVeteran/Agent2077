import { useState } from "react";
import { Brain, Loader2, ChevronDown, ChevronRight } from "lucide-react";

// Pure visibility/expand logic, exported for unit testing without a DOM.
// The panel only ever renders when the model emitted non-whitespace reasoning —
// it never fabricates chain-of-thought.
export function shouldRenderThinking(content: string): boolean {
  return content.trim().length > 0;
}

// Expanded follows `streaming` until the user toggles, then follows their choice.
export function isThinkingExpanded(streaming: boolean, userToggled: boolean, open: boolean): boolean {
  return userToggled ? open : streaming;
}

// ── Thinking Panel ───────────────────────────────────────────────
// Collapsible window that surfaces the model's reasoning/thinking tokens
// (delta.reasoning / reasoning_content, streamed as `thinking` SSE events).
// Only ever shows text the model actually emitted — never fabricated. Collapsed
// by default so it doesn't dominate the transcript; expand to read the reasoning.
// Shared across main chat, workspace chat, and self-dev chat.
export function ThinkingPanel({
  content,
  streaming,
  compact = false,
}: {
  content: string;
  streaming: boolean;
  /** Tighter spacing/text for the narrow workspace + self-dev chat columns. */
  compact?: boolean;
}) {
  // Auto-expand while reasoning is actively streaming so the user sees it live;
  // they can still collapse manually (tracked once they interact).
  const [userToggled, setUserToggled] = useState(false);
  const [open, setOpen] = useState(false);
  const expanded = isThinkingExpanded(streaming, userToggled, open);

  if (!shouldRenderThinking(content)) return null;

  const icon = compact ? "w-3 h-3" : "w-3.5 h-3.5";

  return (
    <div className="border border-border/60 rounded-lg bg-muted/20 overflow-hidden" data-testid="thinking-panel">
      <button
        type="button"
        onClick={() => { setUserToggled(true); setOpen(!expanded); }}
        className={`w-full flex items-center gap-2 text-left hover:bg-muted/40 transition-colors ${compact ? "px-2 py-1.5" : "px-3 py-2"}`}
      >
        {expanded ? <ChevronDown className={`${icon} text-muted-foreground`} /> : <ChevronRight className={`${icon} text-muted-foreground`} />}
        <Brain className={`${icon} text-primary/70`} />
        <span className={`font-medium text-muted-foreground ${compact ? "text-[11px]" : "text-xs"}`}>
          {streaming ? "Thinking…" : "Thought process"}
        </span>
        {streaming && <Loader2 className="w-3 h-3 animate-spin text-primary/60 ml-auto" />}
      </button>
      {expanded && (
        <div className={compact ? "px-2 pb-2 pt-0" : "px-3 pb-3 pt-0"}>
          <pre className={`leading-relaxed text-muted-foreground/80 whitespace-pre-wrap break-words font-mono overflow-y-auto ${compact ? "text-[10px] max-h-60" : "text-[11px] max-h-80"}`}>
            {content}
          </pre>
        </div>
      )}
    </div>
  );
}
