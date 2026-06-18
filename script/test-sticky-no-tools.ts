/**
 * Sticky no-tools / forced-tool-nudge gating test (v16.74.22).
 *
 * Pins the two approved fixes for the "trigger-happy tool mode" report:
 *
 *   Fix #1 — the forced-tool nudge ("You MUST now call your first tool …
 *            call a tool NOW.") must NOT fire on a suppressed/non-actionable
 *            turn. Both nudge sites in server/lib/agent-loop.ts (native +
 *            prompted) must guard on `!suppressToolsForTurn`.
 *
 *   Fix #2 — casual/no-tool suppression is STICKY for the whole turn. When the
 *            first-turn tool choice is "none", every iteration must keep
 *            tool_choice "none" AND omit the tool schemas — it must not flip
 *            back to "auto" on iteration 2. Prompted tool instructions must
 *            also be withheld on a suppressed turn.
 *
 * Part A drives the real request-router decision so the runtime contract
 * (casual turn → suppression) is exercised, not just asserted statically.
 * Part B is static source inspection of agent-loop.ts (the loop itself needs a
 * live LLM/stream to run, so the wiring is pinned by source).
 *
 * Run with: npx tsx script/test-sticky-no-tools.ts
 */
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { decideToolChoice, isCasualChat } from "../server/lib/request-router.js";

let failures = 0;
function check(label: string, ok: boolean, detail?: string) {
  const mark = ok ? "PASS" : "FAIL";
  console.log(`[${mark}] ${label}${detail ? " — " + detail : ""}`);
  if (!ok) { failures++; process.exitCode = 1; }
}

// ── Part A — runtime: a plain chat turn is suppressed ───────────────────────
// These feed the same decideToolChoice the agent loop uses to set
// suppressToolsForTurn = (firstTurnToolChoice === "none").
check("casual greeting → tool_choice none (suppressed)",
  decideToolChoice("how's it going?") === "none");
check("short non-actionable question → suppressed",
  isCasualChat("what do you think?") === true && decideToolChoice("what do you think?") === "none");

// A clearly actionable request must still enable tools (no over-suppression).
check("actionable build request → tool_choice auto (NOT suppressed)",
  decideToolChoice("build me a todo app with a deploy step") === "auto");
check("actionable file request → auto",
  decideToolChoice("read server/routes.ts and fix the bug") === "auto");

// ── Part B — static: agent-loop wiring ──────────────────────────────────────
const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const loop = readFileSync(join(root, "server/lib/agent-loop.ts"), "utf8");

check("agent-loop derives suppressToolsForTurn from firstTurnToolChoice",
  /const suppressToolsForTurn = firstTurnToolChoice === "none";/.test(loop));

// Fix #2: sticky tool_choice across iterations (not iteration===1 only).
check("toolChoice stays 'none' for the whole suppressed turn",
  /toolChoice: suppressToolsForTurn \? "none" : \(iteration === 1 \? firstTurnToolChoice : "auto"\)/.test(loop));

// Fix #2: schemas omitted on a suppressed turn, not merely tool_choice none.
check("native streamOptions omits tool schemas when suppressed",
  /tools: suppressToolsForTurn \? \[\] : tools/.test(loop));

// Fix #2: prompted tool instructions withheld on a suppressed turn.
check("prompted tool instructions skipped when suppressed",
  /if \(!useNativeToolCalling && tools\.length > 0 && !suppressToolsForTurn\)/.test(loop));

// Fix #1: BOTH forced-tool nudge sites gate on !suppressToolsForTurn.
const gatedNudges = loop.match(
  /if \(!suppressToolsForTurn && allToolCalls\.length === 0 && \w+\.length > 50 && !cancelled\)/g
) ?? [];
check("both forced-tool nudge sites gated on !suppressToolsForTurn",
  gatedNudges.length >= 2, `found ${gatedNudges.length}`);

// Guard against regression: there must be NO un-gated nudge guard left behind.
const ungatedNudges = loop.match(
  /(?<!!suppressToolsForTurn && )if \(allToolCalls\.length === 0 && \w+\.length > 50 && !cancelled\)/g
) ?? [];
check("no un-gated forced-tool nudge guard remains",
  ungatedNudges.length === 0, `found ${ungatedNudges.length}`);

// The forced-tool text itself is unchanged (we gate it, not reword it).
check("forced-tool nudge text still present (gated, not removed)",
  /You MUST now call your first tool to begin the work\. Do not write more text — call a tool NOW\./.test(loop));

console.log(failures === 0 ? "\nAll sticky-no-tools checks passed." : `\n${failures} check(s) failed.`);
if (failures > 0) process.exit(1);
