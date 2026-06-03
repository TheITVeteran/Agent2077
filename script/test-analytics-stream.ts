/**
 * v16.74 LM Studio streaming-analytics regression tests.
 *
 * Root bug these guard against: chatCompletionStream() used to call
 * analyticsStore.record() AFTER its final `yield {type:"done"}`. The agent loop
 * breaks out of its `for await` as soon as it sees "done", which .return()s the
 * generator — so the record call never executed and NO analytics row was written
 * for any streamed chat. On top of that, LM Studio / llama.cpp / Ollama streams
 * usually omit the `usage` object, so even when a row was written the token
 * counts were 0.
 *
 * These tests simulate those exact conditions by mocking global.fetch to return
 * an OpenAI-compatible SSE stream WITHOUT usage tokens, then consuming the
 * generator the way the agent loop does (break on "done"). We assert a `chat`
 * analytics row is recorded with estimated (non-zero) tokens.
 *
 * Run with: npx tsx script/test-analytics-stream.ts
 * Uses a throwaway DB via AGENT2077_DB_PATH so it never touches the dev data dir.
 */
import fs from "fs";
import os from "os";
import path from "path";

const TMP_DB = path.join(os.tmpdir(), `agent2077-analytics-stream-test-${Date.now()}.db`);
process.env.AGENT2077_DB_PATH = TMP_DB;

const { bootstrapSchema, runMigrations, initNewTables } = await import("../server/db.js");
bootstrapSchema();
runMigrations();
initNewTables();

const { analyticsStore, endpointStore, modelStore } = await import("../server/storage.js");
const { chatCompletionStream } = await import("../server/lib/llm-client.js");

let failures = 0;
function check(label: string, ok: boolean, detail?: string) {
  const mark = ok ? "PASS" : "FAIL";
  console.log(`[${mark}] ${label}${detail ? " — " + detail : ""}`);
  if (!ok) { failures++; process.exitCode = 1; }
}

/** Build a fake fetch that streams the given SSE lines as a ReadableStream. */
function mockFetchSSE(sseChunks: string[]) {
  return async (_url: any, _init: any) => {
    const encoder = new TextEncoder();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of sseChunks) controller.enqueue(encoder.encode(chunk));
        controller.close();
      },
    });
    return {
      ok: true,
      status: 200,
      body,
      headers: { get: () => null },
      text: async () => "",
    } as any;
  };
}

const realFetch = global.fetch;

try {
  // ── Seed an LM Studio endpoint + model ──────────────────────────────────────
  const endpoint = endpointStore.create({
    name: "Local LM Studio", url: "http://localhost:1234", providerType: "lmstudio",
  });
  const model = modelStore.create({
    endpointId: endpoint.id, modelId: "qwen2.5-coder-7b", isEnabled: true,
  });

  const messages = [
    { role: "system" as const, content: "You are a helpful coding assistant. ".repeat(10) },
    { role: "user" as const, content: "Write a function that reverses a string in TypeScript." },
  ];

  // ── Case 1: LM Studio streaming WITHOUT usage; consumer breaks on "done" ─────
  // This is the exact shape LM Studio emits: content deltas, then [DONE], no usage.
  const completion = "Sure! Here is a concise implementation:\n\nconst rev = (s: string) => s.split('').reverse().join('');\n";
  const sse1: string[] = [];
  // chunk the completion into a few content deltas
  for (const piece of completion.match(/.{1,20}/gs) || []) {
    sse1.push(`data: ${JSON.stringify({ choices: [{ delta: { content: piece } }] })}\n\n`);
  }
  sse1.push(`data: [DONE]\n\n`);

  global.fetch = mockFetchSSE(sse1) as any;

  let sawDone = false;
  let streamedContent = "";
  for await (const chunk of chatCompletionStream(endpoint, model, messages, { taskType: "coding", conversationId: 42 })) {
    if (chunk.type === "content") streamedContent += chunk.content;
    if (chunk.type === "done") {
      sawDone = true;
      break; // ← agent loop behaviour: break immediately on done (was killing the record)
    }
  }

  check("case1: stream produced content", streamedContent.length > 0, `len=${streamedContent.length}`);
  check("case1: saw done event", sawDone);

  const rows1 = analyticsStore.getRecent(100).filter(r => r.eventType === "chat");
  check("case1: a chat analytics row was recorded", rows1.length === 1, `got ${rows1.length}`);
  const row1 = rows1[0];
  check("case1: tokensIn estimated (non-zero)", (row1?.tokensIn ?? 0) > 0, `tokensIn=${row1?.tokensIn}`);
  check("case1: tokensOut estimated (non-zero)", (row1?.tokensOut ?? 0) > 0, `tokensOut=${row1?.tokensOut}`);
  check("case1: model recorded", row1?.modelId === "qwen2.5-coder-7b", row1?.modelId ?? "");
  check("case1: endpoint recorded", row1?.endpointId === endpoint.id, String(row1?.endpointId));
  check("case1: taskType recorded", row1?.taskType === "coding", row1?.taskType ?? "");
  check("case1: success true", row1?.success === true);
  const meta1 = row1?.metadata ? JSON.parse(row1.metadata) : {};
  check("case1: conversationId in metadata", meta1.conversationId === 42, JSON.stringify(meta1));
  check("case1: marked estimated", meta1.estimated === true, JSON.stringify(meta1));
  check("case1: marked streamed", meta1.streamed === true, JSON.stringify(meta1));
  check("case1: provider in metadata", meta1.provider === "lmstudio", JSON.stringify(meta1));

  // ── Case 2: generic OpenAI-compatible stream using finish_reason (no [DONE]) ─
  // Some servers emit finish_reason:"stop" instead of a [DONE] sentinel and also
  // omit usage. Consumer again breaks on done.
  const sse2 = [
    `data: ${JSON.stringify({ choices: [{ delta: { content: "Hello there, this is a longer answer." } }] })}\n\n`,
    `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }] })}\n\n`,
  ];
  global.fetch = mockFetchSSE(sse2) as any;

  for await (const chunk of chatCompletionStream(endpoint, model, messages, { taskType: "general", conversationId: 7 })) {
    if (chunk.type === "done") break;
  }
  const rows2 = analyticsStore.getRecent(100).filter(r => r.eventType === "chat");
  check("case2: second chat row recorded", rows2.length === 2, `got ${rows2.length}`);
  const row2 = rows2.find(r => {
    try { return JSON.parse(r.metadata || "{}").conversationId === 7; } catch { return false; }
  });
  check("case2: finish_reason path recorded", !!row2);
  check("case2: tokensOut estimated", (row2?.tokensOut ?? 0) > 0, `tokensOut=${row2?.tokensOut}`);

  // ── Case 3: provider DID send usage — real counts win over estimates ────────
  const sse3 = [
    `data: ${JSON.stringify({ choices: [{ delta: { content: "ok" } }] })}\n\n`,
    `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 1234, completion_tokens: 56 } })}\n\n`,
    `data: [DONE]\n\n`,
  ];
  global.fetch = mockFetchSSE(sse3) as any;
  for await (const chunk of chatCompletionStream(endpoint, model, messages, { conversationId: 9 })) {
    if (chunk.type === "done") break;
  }
  const row3 = analyticsStore.getRecent(100).filter(r => r.eventType === "chat")
    .find(r => { try { return JSON.parse(r.metadata || "{}").conversationId === 9; } catch { return false; } });
  check("case3: real prompt tokens used", row3?.tokensIn === 1234, `tokensIn=${row3?.tokensIn}`);
  check("case3: real completion tokens used", row3?.tokensOut === 56, `tokensOut=${row3?.tokensOut}`);
  const meta3 = row3?.metadata ? JSON.parse(row3.metadata) : {};
  check("case3: NOT marked estimated", meta3.estimated === false, JSON.stringify(meta3));

  // ── Case 4: tool-calling stream with no content/usage still records ─────────
  const toolModel = modelStore.create({
    endpointId: endpoint.id, modelId: "tool-model", isEnabled: true, supportsToolCalling: true,
  });
  const sse4 = [
    `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: "call_1", function: { name: "read_file", arguments: '{"path":"' } }] } }] })}\n\n`,
    `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: '/tmp/x.txt"}' } }] } }] })}\n\n`,
    `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "tool_calls" }] })}\n\n`,
  ];
  global.fetch = mockFetchSSE(sse4) as any;
  let sawToolCall = false;
  for await (const chunk of chatCompletionStream(endpoint, toolModel, messages, { conversationId: 11, tools: [{ type: "function", function: { name: "read_file", description: "", parameters: {} } }] as any })) {
    if (chunk.type === "tool_call") sawToolCall = true;
    if (chunk.type === "done") break;
  }
  check("case4: tool call surfaced", sawToolCall);
  const row4 = analyticsStore.getRecent(100).filter(r => r.eventType === "chat")
    .find(r => { try { return JSON.parse(r.metadata || "{}").conversationId === 11; } catch { return false; } });
  check("case4: tool-calling stream recorded a row", !!row4);
  check("case4: tokensOut estimated from tool args", (row4?.tokensOut ?? 0) > 0, `tokensOut=${row4?.tokensOut}`);
} finally {
  global.fetch = realFetch;
  for (const suffix of ["", "-wal", "-shm"]) {
    try { fs.unlinkSync(TMP_DB + suffix); } catch { /* ignore */ }
  }
}

console.log(failures === 0 ? "\nAll streaming-analytics tests passed." : `\n${failures} streaming-analytics test(s) failed.`);
