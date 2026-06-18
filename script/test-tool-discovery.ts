/**
 * Smoke test for proactive tool discovery + SSH routing (v16.74.19).
 * Run with: npx tsx script/test-tool-discovery.ts
 *
 * Covers the three behaviors the fix targets:
 *  1. Casual chat still suppresses tools (no over-eager tool use, no shell_run).
 *  2. An explicit SSH/remote request routes to shell_run, force-includes the SSH
 *     tools, and the selector actually picks ssh_exec / ssh_list_targets.
 *  3. searchToolNames("ssh") surfaces the SSH tools (so promotion makes them
 *     callable), while a genuinely missing capability returns [] (so the agent
 *     only claims inability AFTER a registry search comes up empty).
 *
 * Imports the real tool modules so the registry is populated, then exercises the
 * real selector + router against it.
 */
import { routeRequest, decideToolChoice, isCasualChat, hasActionableSignal } from "../server/lib/request-router.js";
import { selectTools } from "../server/lib/tool-selector.js";
import { getAllTools } from "../server/tools/registry.js";
import { searchToolNames } from "../server/tools/tool-discovery.js";
// Side-effect imports: register the tools we assert against.
import "../server/tools/ssh-tools.js";
import "../server/tools/tool-discovery.js";

function check(label: string, ok: boolean, detail?: string) {
  const mark = ok ? "PASS" : "FAIL";
  console.log(`[${mark}] ${label}${detail ? " — " + detail : ""}`);
  if (!ok) process.exitCode = 1;
}

const allTools = getAllTools();

// ── 1. Casual chat: suppression preserved ───────────────────────────────────
for (const msg of ["hi", "sup nerd", "how's it going?", "thanks!", "lol that's wild"]) {
  const r = routeRequest(msg);
  check(`casual "${msg}" → not shell_run`, r.route !== "shell_run", r.route);
  check(`casual "${msg}" → tool_choice none`, decideToolChoice(msg) === "none");
  check(`casual "${msg}" → isCasualChat`, isCasualChat(msg) === true);
}

// ── 2. Explicit SSH request: route + forceInclude + selection ───────────────
{
  const msg = "ssh into the dgx and run nvidia-smi";
  const r = routeRequest(msg);
  check("ssh request → shell_run route", r.route === "shell_run", r.route);
  check("ssh request → forceInclude has ssh_exec", r.forceInclude.includes("ssh_exec"));
  check("ssh request → forceInclude has ssh_list_targets", r.forceInclude.includes("ssh_list_targets"));
  check("ssh request → actionable signal", hasActionableSignal(msg) === true);
  check("ssh request → tool_choice auto", decideToolChoice(msg) === "auto");

  const sel = selectTools({
    allTools,
    taskType: "general",
    model: { modelId: "qwen3-122b", supportsToolCalling: true } as any,
    modelSize: "large",
    lastUserMessage: msg,
    route: r,
  });
  check("ssh request → selects ssh_exec", sel.selectedNames.has("ssh_exec"));
  check("ssh request → selects ssh_list_targets", sel.selectedNames.has("ssh_list_targets"));
}

// ── 3. searchToolNames: discovery surface for promotion ─────────────────────
{
  const hits = searchToolNames("ssh");
  check("searchToolNames('ssh') → ssh_exec", hits.includes("ssh_exec"), hits.join(","));
  check("searchToolNames('ssh') → ssh_list_targets", hits.includes("ssh_list_targets"));

  const remote = searchToolNames("remote shell");
  check("searchToolNames('remote shell') → ssh_exec", remote.includes("ssh_exec"), remote.join(","));

  const none = searchToolNames("flux-capacitor-time-travel");
  check("searchToolNames(missing capability) → []", none.length === 0, none.join(","));
}

if (process.exitCode === 1) {
  console.error("\nSOME TESTS FAILED");
  process.exit(1);
}
console.log("\nAll tool-discovery tests passed.");
