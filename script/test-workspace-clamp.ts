/**
 * Workspace chat-resize clamp smoke test.
 *
 * Pins `clampChatWidth` so the chat column can grow toward ~2/3 of the available
 * width when there's room, but never squeezes the center editor below
 * `editorMin`. Regression target: a 1440px viewport with the left nav (~240px)
 * excluded leaves a 1200px layout container; dragging chat to the far right used
 * to clamp at 800px (2/3) and collapse the editor to ~37px.
 *
 * Run with: npx tsx script/test-workspace-clamp.ts
 */
import { clampChatWidth, WORKSPACE_LAYOUT } from "../client/src/lib/workspace-layout.js";

let failures = 0;
function check(label: string, ok: boolean, detail?: string) {
  const mark = ok ? "PASS" : "FAIL";
  console.log(`[${mark}] ${label}${detail ? " — " + detail : ""}`);
  if (!ok) { failures++; process.exitCode = 1; }
}

const { chatMin, editorMin, handleSlack } = WORKSPACE_LAYOUT;

// ── The QA regression: 1200px container (1440 viewport − 240 nav) ────────────
{
  const avail = 1200, ft = 200;
  const clamped = clampChatWidth(99999, avail, ft);
  const editor = avail - clamped - ft - handleSlack;
  check("1200px: chat clamps below 2/3 to protect editor",
    clamped < Math.round((avail * 2) / 3), `chat=${clamped}`);
  check("1200px: editor never below editorMin", editor >= editorMin, `editor=${editor}`);
  check("1200px: chat == available − ft − editorMin − slack",
    clamped === avail - ft - editorMin - handleSlack, `chat=${clamped}`);
}

// ── Wide screen with room: chat reaches the 2/3 target ───────────────────────
{
  const avail = 2400, ft = 200;
  const clamped = clampChatWidth(99999, avail, ft);
  const twoThirds = Math.round((avail * 2) / 3);
  check("2400px: chat reaches ~2/3 target", clamped === twoThirds, `chat=${clamped} target=${twoThirds}`);
  const editor = avail - clamped - ft - handleSlack;
  check("2400px: editor still above editorMin", editor >= editorMin, `editor=${editor}`);
}

// ── A wider file tree eats into the room left for chat ───────────────────────
{
  const avail = 1200;
  const narrow = clampChatWidth(99999, avail, 200);
  const wide = clampChatWidth(99999, avail, 480);
  check("wider file tree reduces chat max", wide < narrow, `narrow=${narrow} wide=${wide}`);
  check("wide-tree case still protects editor",
    avail - wide - 480 - handleSlack >= editorMin);
}

// ── Desired below max is honored verbatim (down to chatMin) ──────────────────
check("desired within range is returned as-is", clampChatWidth(420, 1200, 200) === 420);
check("desired below chatMin floors at chatMin", clampChatWidth(50, 1200, 200) === chatMin);

// ── Narrow screens never go negative / never below chatMin ───────────────────
{
  const clamped = clampChatWidth(99999, 600, 200);
  check("narrow screen floors at chatMin (no negative)", clamped === chatMin, `chat=${clamped}`);
}

console.log(failures === 0 ? "\nAll workspace-clamp tests passed." : `\n${failures} test(s) failed.`);
