/**
 * Stop-button / cancellation smoke test (v16.74.24).
 *
 * Root cause this guards against: POST /api/chat/stop used to call only
 * cancelRequest(requestId), which aborts the single in-flight fetch and removes
 * it from the map. That does NOT stop the agent loop — if the stop landed during
 * tool execution or between iterations, the next chatCompletionStream registered
 * a fresh controller and generation resumed, so Stop looked like it did nothing.
 *
 * The fix introduced a loop-canceller registry: the agent loop registers a
 * cancel function keyed by requestId, and stopRequest(requestId) invokes it so
 * the loop's `cancelled` flag flips + its persistent AbortController aborts
 * regardless of when the stop arrives. This test pins that contract.
 *
 * Run with: npx tsx script/test-chat-stop.ts
 */
import {
  registerLoopCanceller,
  unregisterLoopCanceller,
  stopRequest,
  cancelRequest,
} from "../server/lib/llm-client.js";

let failures = 0;
function check(label: string, ok: boolean, detail?: string) {
  const mark = ok ? "PASS" : "FAIL";
  console.log(`[${mark}] ${label}${detail ? " — " + detail : ""}`);
  if (!ok) { failures++; process.exitCode = 1; }
}

// ── 1. stopRequest invokes the registered loop canceller ─────────────────────
{
  const reqId = "test-req-1";
  let cancelled = false;
  registerLoopCanceller(reqId, () => { cancelled = true; });
  stopRequest(reqId);
  check("stopRequest invokes the registered loop canceller", cancelled);
}

// ── 2. A second stopRequest after unregister is a safe no-op ─────────────────
{
  const reqId = "test-req-2";
  let count = 0;
  registerLoopCanceller(reqId, () => { count++; });
  stopRequest(reqId);
  unregisterLoopCanceller(reqId);
  stopRequest(reqId); // no canceller now → falls back to cancelRequest (no throw)
  check("canceller fires exactly once, post-unregister stop is a no-op", count === 1, `count=${count}`);
}

// ── 3. stopRequest with no registered loop does not throw ────────────────────
{
  let threw = false;
  try {
    stopRequest("never-registered");
  } catch {
    threw = true;
  }
  check("stopRequest with no loop registered does not throw", !threw);
}

// ── 4. A throwing canceller is swallowed (stop must never crash the route) ───
{
  const reqId = "test-req-4";
  registerLoopCanceller(reqId, () => { throw new Error("boom"); });
  let threw = false;
  try {
    stopRequest(reqId);
  } catch {
    threw = true;
  }
  check("stopRequest swallows a throwing canceller", !threw);
  unregisterLoopCanceller(reqId);
}

// ── 5. cancelRequest on an unknown id is a safe no-op ────────────────────────
{
  let threw = false;
  try {
    cancelRequest("unknown-request-id");
  } catch {
    threw = true;
  }
  check("cancelRequest on unknown id does not throw", !threw);
}

console.log(failures === 0 ? "\nAll stop/cancel checks passed." : `\n${failures} check(s) failed.`);
