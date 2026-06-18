/**
 * Thinking-panel + workspace-layout smoke test.
 *
 * Covers two UI updates:
 *  1. The collapsible thinking-process window (extracted to a shared component)
 *     is reused by all three chat surfaces — main, workspace, and self-dev.
 *  2. The workspace chat moved to the LEFT, the file tree to the RIGHT, and the
 *     chat can be resized up to ~2/3 of the viewport width.
 *
 * The visibility/expand decisions are pulled out as pure helpers so we can pin
 * them without a DOM. The cross-file wiring + layout classes are asserted by
 * grepping source, which is enough to catch an accidental revert.
 *
 * Run with: npx tsx script/test-thinking-panel.ts
 */
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, resolve } from "path";
import { shouldRenderThinking, isThinkingExpanded } from "../client/src/components/ThinkingPanel.js";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "..");

let failures = 0;
function check(label: string, ok: boolean, detail?: string) {
  const mark = ok ? "PASS" : "FAIL";
  console.log(`[${mark}] ${label}${detail ? " — " + detail : ""}`);
  if (!ok) { failures++; process.exitCode = 1; }
}
function read(rel: string): string {
  return readFileSync(resolve(root, rel), "utf8");
}

// ── 1. Pure visibility logic — never fabricate, only show emitted reasoning ──
check("empty content → hidden", shouldRenderThinking("") === false);
check("whitespace-only → hidden", shouldRenderThinking("   \n\t ") === false);
check("real reasoning → shown", shouldRenderThinking("Let me think about this") === true);

// ── 2. Expand logic: follow streaming until the user takes control ───────────
check("streaming + untouched → expanded", isThinkingExpanded(true, false, false) === true);
check("idle + untouched → collapsed", isThinkingExpanded(false, false, false) === false);
check("user opened while idle → expanded", isThinkingExpanded(false, true, true) === true);
check("user collapsed while streaming → collapsed",
  isThinkingExpanded(true, true, false) === false);

// ── 3. All three chat surfaces import & render the shared panel ──────────────
for (const page of ["client/src/pages/chat.tsx", "client/src/pages/workspace.tsx", "client/src/pages/self-dev.tsx"]) {
  const src = read(page);
  check(`${page} imports shared ThinkingPanel`,
    /import\s*\{\s*ThinkingPanel\s*\}\s*from\s*"@\/components\/ThinkingPanel"/.test(src));
  check(`${page} renders <ThinkingPanel`, src.includes("<ThinkingPanel"));
  check(`${page} feeds thinkingContent`, src.includes("thinkingContent"));
}

// The shared component must NOT be re-declared inside any page (dedupe goal).
check("chat.tsx no longer declares ThinkingPanel locally",
  !/function ThinkingPanel\(/.test(read("client/src/pages/chat.tsx")));

// ── 4. Workspace layout: chat LEFT (order-1), file tree RIGHT (order-5) ──────
const ws = read("client/src/pages/workspace.tsx");
check("workspace chat panel is order-1 (left) with border-r",
  ws.includes("order-1 shrink-0 flex flex-col border-r border-border"));
check("file tree panel is order-5 (right) with border-l",
  ws.includes("order-5 shrink-0 flex flex-col border-l border-border"));
check("chat grows with +delta (now on the left)",
  ws.includes("dragStartRef.current.chatWidth + delta"));
check("chat width uses the clampChatWidth helper",
  ws.includes("clampChatWidth("));
check("chat clamp measures the layout container (excludes left nav)",
  ws.includes("layoutRef.current?.clientWidth"));
check("file tree grows with -delta (now on the right)",
  ws.includes("dragStartRef.current.fileTreeWidth - delta"));

console.log(failures === 0 ? "\nAll thinking-panel/layout tests passed." : `\n${failures} test(s) failed.`);
