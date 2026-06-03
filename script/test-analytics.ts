/**
 * v16.74 analytics smoke tests:
 *  - analyticsStore.record persists chat events with taskType + conversationId metadata
 *  - getTaskTypeDistribution aggregates by task_type (was always empty before the fix
 *    because chat events never carried a task_type)
 *  - getTokenUsageByConversationJoined groups per conversation via metadata.conversationId
 *    and joins the real conversation title (previously collapsed to a single "Unknown" row)
 *  - getDailyUsage / getTokenUsageByModel / getEfficiencyMetrics return sane aggregates
 *
 * Run with: npx tsx script/test-analytics.ts
 *
 * Uses a throwaway DB via AGENT2077_DB_PATH so it never touches the dev data dir.
 */
import fs from "fs";
import os from "os";
import path from "path";

// Point the DB layer at a fresh temp file BEFORE importing storage/db.
const TMP_DB = path.join(os.tmpdir(), `agent2077-analytics-test-${Date.now()}.db`);
process.env.AGENT2077_DB_PATH = TMP_DB;

// Bootstrap schema on the fresh temp DB (server/index.ts does this at boot).
const { bootstrapSchema, runMigrations, initNewTables } = await import("../server/db.js");
bootstrapSchema();
runMigrations();
initNewTables();

const { analyticsStore, conversationStore } = await import("../server/storage.js");

let failures = 0;
function check(label: string, ok: boolean, detail?: string) {
  const mark = ok ? "PASS" : "FAIL";
  console.log(`[${mark}] ${label}${detail ? " — " + detail : ""}`);
  if (!ok) { failures++; process.exitCode = 1; }
}

try {
  // Two conversations so per-conversation grouping is meaningful.
  const convA = conversationStore.create({ title: "Refactor auth module" });
  const convB = conversationStore.create({ title: "Research vector DBs" });

  // Chat events carrying the metadata the fix now threads through.
  analyticsStore.record({
    eventType: "chat", modelId: "openai/gpt-4o", taskType: "coding",
    tokensIn: 1000, tokensOut: 200, durationMs: 1200, success: true,
    metadata: JSON.stringify({ conversationId: convA.id }),
  });
  analyticsStore.record({
    eventType: "chat", modelId: "openai/gpt-4o", taskType: "coding",
    tokensIn: 500, tokensOut: 100, durationMs: 800, success: true,
    metadata: JSON.stringify({ conversationId: convA.id }),
  });
  analyticsStore.record({
    eventType: "chat", modelId: "anthropic/claude-sonnet-4", taskType: "research",
    tokensIn: 2000, tokensOut: 400, durationMs: 2000, success: true,
    metadata: JSON.stringify({ conversationId: convB.id }),
  });
  // A tool_call + a failure to exercise efficiency metrics.
  analyticsStore.record({ eventType: "tool_call", success: true, durationMs: 50 });
  analyticsStore.record({ eventType: "code_exec", success: false, durationMs: 30 });

  // ── Task-type distribution ────────────────────────────────────────────────
  const dist = analyticsStore.getTaskTypeDistribution();
  const coding = dist.find(d => d.taskType === "coding");
  const research = dist.find(d => d.taskType === "research");
  check("task-dist: coding counted", coding?.count === 2, `got ${coding?.count}`);
  check("task-dist: research counted", research?.count === 1, `got ${research?.count}`);
  check("task-dist: no null bucket", !dist.some(d => d.taskType == null), JSON.stringify(dist));

  // ── Per-conversation token usage (joined to title) ──────────────────────────
  const rows = analyticsStore.getTokenUsageByConversationJoined(20);
  const rowA = rows.find(r => r.conversationId === convA.id);
  const rowB = rows.find(r => r.conversationId === convB.id);
  check("conv-usage: two conversation rows", rows.length === 2, `got ${rows.length}`);
  check("conv-usage: convA title joined", rowA?.title === "Refactor auth module", rowA?.title);
  check("conv-usage: convA tokens summed", rowA?.totalIn === 1500 && rowA?.totalOut === 300,
    `in=${rowA?.totalIn} out=${rowA?.totalOut}`);
  check("conv-usage: convB title joined", rowB?.title === "Research vector DBs", rowB?.title);
  check("conv-usage: no collapsed Unknown row", !rows.some(r => r.title === "Unknown"), JSON.stringify(rows.map(r => r.title)));

  // ── Tokens by model ─────────────────────────────────────────────────────────
  const byModel = analyticsStore.getTokenUsageByModel();
  const gpt = byModel.find(m => m.modelId === "openai/gpt-4o");
  check("by-model: gpt-4o totals", gpt?.totalIn === 1500 && gpt?.totalOut === 300,
    `in=${gpt?.totalIn} out=${gpt?.totalOut}`);
  check("by-model: two models", byModel.length === 2, `got ${byModel.length}`);

  // ── Daily usage ──────────────────────────────────────────────────────────────
  const daily = analyticsStore.getDailyUsage(30);
  const totalDailyEvents = daily.reduce((s, d) => s + d.events, 0);
  check("daily: all 5 events present", totalDailyEvents === 5, `got ${totalDailyEvents}`);

  // ── Efficiency metrics ────────────────────────────────────────────────────────
  const eff = analyticsStore.getEfficiencyMetrics();
  check("efficiency: 5 total events", eff.totalEvents === 5, `got ${eff.totalEvents}`);
  check("efficiency: 4 success events", eff.successEvents === 4, `got ${eff.successEvents}`);
  check("efficiency: 1 tool-call event", eff.toolCallEvents === 1, `got ${eff.toolCallEvents}`);
  check("efficiency: tokens in summed", eff.totalTokensIn === 3500, `got ${eff.totalTokensIn}`);
} finally {
  // Clean up temp DB + WAL/SHM sidecars.
  for (const suffix of ["", "-wal", "-shm"]) {
    try { fs.unlinkSync(TMP_DB + suffix); } catch { /* ignore */ }
  }
}

console.log(failures === 0 ? "\nAll analytics smoke tests passed." : `\n${failures} analytics smoke test(s) failed.`);
