// ── Workspace layout constants + resize clamp math ───────────────────────────
// Dependency-free so it can be unit-tested without pulling the workspace page's
// CodeMirror/React imports. Used by the resizable [Chat] | [Editor] | [File Tree]
// columns in workspace.tsx.

export const WORKSPACE_LAYOUT = {
  chatMin: 200,
  /** Editor must never be squeezed below this — keeps a usable code column. */
  editorMin: 420,
  /** Slack for the two drag handles + borders between the three columns. */
  handleSlack: 16,
} as const;

/**
 * Max width the chat column may grow to. Chat targets ~2/3 of the available
 * width, but can never push the center editor below `editorMin`: we also reserve
 * the file tree's current width and a little handle/border slack. Returns at
 * least `chatMin` so the math never produces a degenerate (or negative) clamp on
 * very narrow screens.
 *
 * @param desired         the width the drag would set chat to (start + delta)
 * @param availableWidth  width of the 3-panel container (NOT window.innerWidth —
 *                        excludes the app's left navigation sidebar)
 * @param fileTreeWidth   current width reserved by the right-hand file tree
 */
export function clampChatWidth(
  desired: number,
  availableWidth: number,
  fileTreeWidth: number,
): number {
  const twoThirds = Math.round((availableWidth * 2) / 3);
  const roomForChat =
    availableWidth - fileTreeWidth - WORKSPACE_LAYOUT.editorMin - WORKSPACE_LAYOUT.handleSlack;
  const max = Math.max(WORKSPACE_LAYOUT.chatMin, Math.min(twoThirds, roomForChat));
  return Math.max(WORKSPACE_LAYOUT.chatMin, Math.min(max, desired));
}
