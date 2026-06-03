import { useState, useEffect, useRef, useMemo } from "react";
import {
  Activity, Brain, GitBranch, Search, Globe, Wrench, ListChecks,
  RefreshCw, Wrench as Repair, AlertTriangle, CheckCircle2, CircleDot,
  Circle, ChevronRight, Sparkles, Loader2, Pause,
} from "lucide-react";

// ── Types ──────────────────────────────────────────────────────────────────
export interface ActivityStatus {
  message: string;
  detail?: string;
  timestamp: number;
}

export interface ActivityStep {
  label?: string;
  status?: "running" | "completed" | "failed" | string;
  detail?: string;
}

export interface ActivityPlanStep {
  step: number;
  title: string;
  status: "pending" | "running" | "completed";
}

type Phase =
  | "planning" | "routing" | "thinking" | "searching" | "browsing"
  | "tool" | "research" | "repair" | "retry" | "context" | "paused"
  | "starting" | "done" | "error";

interface PhaseMeta {
  icon: any;
  /** Tailwind text-color class for the phase accent */
  color: string;
}

// Phase → icon + accent color. Kept on the cyberpunk palette already in use.
const PHASE_META: Record<Phase, PhaseMeta> = {
  planning:  { icon: ListChecks,    color: "text-amber-400" },
  routing:   { icon: GitBranch,     color: "text-blue-400" },
  thinking:  { icon: Brain,         color: "text-primary" },
  searching: { icon: Search,        color: "text-cyan-400" },
  browsing:  { icon: Globe,         color: "text-cyan-400" },
  tool:      { icon: Wrench,        color: "text-primary" },
  research:  { icon: Sparkles,      color: "text-violet-400" },
  repair:    { icon: Repair,        color: "text-orange-400" },
  retry:     { icon: RefreshCw,     color: "text-orange-400" },
  context:   { icon: Activity,      color: "text-yellow-400" },
  paused:    { icon: Pause,         color: "text-yellow-400" },
  starting:  { icon: CircleDot,     color: "text-primary" },
  done:      { icon: CheckCircle2,  color: "text-green-400" },
  error:     { icon: AlertTriangle, color: "text-red-400" },
};

// Classify a backend status message (or step label) into a coarse phase so the
// rail can show a meaningful icon/color without backend changes. The server
// already emits human-readable strings (see agent-loop.ts sendStatus()).
export function classify(message: string): Phase {
  const m = (message || "").toLowerCase();
  if (m.includes("repetition") || m.includes("giving up")) return "error";
  if (m.includes("fixing error") || m.includes("repair")) return "repair";
  if (m.includes("retry") || m.includes("switching approach") || m.includes("retrying")) return "retry";
  if (m.includes("balance") || m.includes("paused") || m.includes("stopped")) return "paused";
  if (m.includes("context too large") || m.includes("compress") || m.includes("context")) return "context";
  if (m.includes("plan")) return "planning";
  if (m.includes("rout")) return "routing";
  if (m.includes("research")) return "research";
  if (m.includes("search")) return "searching";
  if (m.includes("fetch") || m.includes("brows") || m.includes("url")) return "browsing";
  if (m.includes("think")) return "thinking";
  if (m.includes("starting") || m.includes("continuing")) return "starting";
  if (
    m.startsWith("using ") || m.startsWith("running ") || m.startsWith("writing") ||
    m.startsWith("reading") || m.startsWith("editing") || m.startsWith("deploying") ||
    m.startsWith("browsing files") || m.startsWith("checking") || m.startsWith("deleting") ||
    m.startsWith("cleaning")
  ) return "tool";
  return "thinking";
}

// A short human label for the phase, used in the condensed header.
const PHASE_LABEL: Record<Phase, string> = {
  planning: "Planning", routing: "Routing", thinking: "Thinking",
  searching: "Searching", browsing: "Browsing", tool: "Using tools",
  research: "Researching", repair: "Repairing", retry: "Retrying",
  context: "Managing context", paused: "Paused", starting: "Starting",
  done: "Done", error: "Recovering",
};

function elapsedLabel(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return `${m}m ${s % 60}s`;
}

// ── Live elapsed timer ───────────────────────────────────────────────────────
function ElapsedTimer({ startedAt, running }: { startedAt: number; running: boolean }) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!running) return;
    const id = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(id);
  }, [running]);
  return (
    <span className="tabular-nums text-[10px] text-muted-foreground/70" data-testid="activity-elapsed">
      {elapsedLabel((running ? now : startedAt) - startedAt)}
    </span>
  );
}

interface ActivityRailProps {
  statusLog: ActivityStatus[];
  steps: ActivityStep[];
  planSteps: ActivityPlanStep[];
  streaming: boolean;
  /** Force the rail open even if not streaming (e.g. while reviewing). */
  defaultOpen?: boolean;
}

/**
 * Odysseus-inspired activity rail.
 *
 * While the assistant is working (but not directly emitting reply text), this
 * shows a single compact "live" header — current phase, icon, animated wave and
 * an elapsed timer — that updates in place. Expanding it reveals a vertical
 * timeline of every status the agent reported, plus the execution plan if one
 * exists. Once the turn finishes the rail auto-condenses into a one-line summary
 * ("12 steps · 3 tools · 8s") so completed work never dominates the transcript.
 */
export function ActivityRail({
  statusLog, steps, planSteps, streaming, defaultOpen,
}: ActivityRailProps) {
  const [userToggled, setUserToggled] = useState<boolean | null>(null);

  // Timeline entries derived from the status log (deduped against repeats).
  const entries = useMemo(() => {
    const out: Array<ActivityStatus & { phase: Phase }> = [];
    for (const s of statusLog) {
      const phase = classify(s.message);
      const last = out[out.length - 1];
      if (last && last.message === s.message && last.detail === s.detail) continue;
      out.push({ ...s, phase });
    }
    return out;
  }, [statusLog]);

  const startedAt = entries.length > 0 ? entries[0].timestamp : Date.now();
  const latest = entries[entries.length - 1];
  const latestPhase: Phase = streaming ? (latest?.phase ?? "thinking") : "done";

  const toolCount = useMemo(
    () => steps.filter(s => (s.label || "").length > 0).length,
    [steps],
  );

  // Open while streaming by default; condensed when finished. User can override.
  const open = userToggled ?? (defaultOpen || streaming);

  if (entries.length === 0 && planSteps.length === 0 && steps.length === 0) {
    return null;
  }

  const HeaderIcon = PHASE_META[latestPhase].icon;
  const headerColor = PHASE_META[latestPhase].color;
  const headerText = streaming
    ? (latest?.message || "Thinking…")
    : `Activity · ${entries.length} step${entries.length === 1 ? "" : "s"}${toolCount ? ` · ${toolCount} tool${toolCount === 1 ? "" : "s"}` : ""}`;

  return (
    <div
      className="bg-card/70 border border-border rounded-lg mb-2 overflow-hidden"
      data-testid="activity-rail"
      data-streaming={streaming ? "true" : "false"}
    >
      {/* ── Compact live header ──────────────────────────────────────────── */}
      <button
        type="button"
        onClick={() => setUserToggled(!open)}
        className="w-full flex items-center gap-2 px-3 py-2 text-left hover:bg-muted/20 transition-colors"
        data-testid="activity-rail-header"
        aria-expanded={open}
      >
        <ChevronRight
          className={`w-3.5 h-3.5 shrink-0 text-muted-foreground transition-transform ${open ? "rotate-90" : ""}`}
        />
        <HeaderIcon className={`w-4 h-4 shrink-0 ${headerColor} ${streaming ? "animate-pulse" : ""}`} />
        <span className="text-xs font-medium text-foreground truncate flex-1 min-w-0">
          {headerText}
        </span>
        {streaming && (
          <span className={`activity-wave flex items-end h-3 shrink-0 ${headerColor}`} aria-hidden>
            <span /><span /><span />
          </span>
        )}
        <ElapsedTimer startedAt={startedAt} running={streaming} />
      </button>

      {/* ── Expanded timeline ────────────────────────────────────────────── */}
      {open && (
        <div className="px-3 pb-3 pt-1">
          {/* Execution plan (if the agent produced one) */}
          {planSteps.length > 0 && (
            <div className="mb-3" data-testid="activity-plan">
              <div className="flex items-center gap-1.5 mb-1.5">
                <ListChecks className="w-3.5 h-3.5 text-amber-400" />
                <span className="text-[11px] font-medium text-foreground">Plan</span>
                <span className="text-[10px] text-muted-foreground ml-auto">
                  {planSteps.filter(s => s.status === "completed").length}/{planSteps.length}
                </span>
              </div>
              <div className="space-y-1 pl-0.5">
                {planSteps.map((p, i) => {
                  const Ico = p.status === "completed" ? CheckCircle2
                    : p.status === "running" ? CircleDot : Circle;
                  const col = p.status === "completed" ? "text-green-400"
                    : p.status === "running" ? "text-primary animate-pulse"
                    : "text-muted-foreground/50";
                  return (
                    <div key={i} className="flex items-center gap-2" data-testid={`activity-plan-step-${i}`}>
                      <Ico className={`w-3 h-3 shrink-0 ${col}`} />
                      <span className={`text-[11px] ${
                        p.status === "completed" ? "text-muted-foreground line-through"
                          : p.status === "running" ? "text-foreground font-medium"
                          : "text-muted-foreground/70"}`}>
                        {p.title}
                      </span>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          {/* Status timeline with a glowing spine */}
          {entries.length > 0 && (
            <div className="relative pl-5" data-testid="activity-timeline">
              {/* Spine */}
              <div className="absolute left-[7px] top-1 bottom-1 w-px bg-border" />
              {streaming && <span className="activity-spine-pulse" style={{ left: "7px" }} />}

              <div className="space-y-1.5">
                {entries.map((e, i) => {
                  const isLast = i === entries.length - 1;
                  const live = streaming && isLast;
                  const meta = PHASE_META[e.phase];
                  const Ico = meta.icon;
                  return (
                    <div
                      key={`${e.timestamp}-${i}`}
                      className="relative flex items-start gap-2"
                      data-testid={`activity-entry-${i}`}
                    >
                      {/* Node dot on the spine */}
                      <span
                        className={`absolute -left-[18px] top-[3px] w-2.5 h-2.5 rounded-full border-2 border-background ${
                          live ? `bg-primary activity-dot-live`
                            : e.phase === "error" ? "bg-red-400"
                            : "bg-muted-foreground/40"
                        }`}
                        aria-hidden
                      />
                      <Ico className={`w-3 h-3 mt-0.5 shrink-0 ${live ? meta.color : `${meta.color} opacity-60`}`} />
                      <div className="min-w-0 flex-1">
                        <span className={`text-[11px] leading-snug ${
                          live ? "text-foreground font-medium" : "text-muted-foreground"}`}>
                          {e.message}
                        </span>
                        {e.detail && (
                          <span className="block text-[10px] text-muted-foreground/50 truncate">
                            {e.detail}
                          </span>
                        )}
                      </div>
                      {live && <Loader2 className="w-3 h-3 animate-spin text-primary shrink-0 mt-0.5" />}
                    </div>
                  );
                })}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export default ActivityRail;
