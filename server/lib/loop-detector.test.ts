// Run with: npx tsx server/lib/loop-detector.test.ts
// Excluded from the build and from tsconfig (**/*.test.ts), so it adds no
// runtime/typecheck weight. Covers the BlockRepetitionDetector that fixes the
// "assistant repeats the same block of text many times" anti-loop gap — the
// case the char-level (8–40 char) and single-line (60+ char) guards both miss.

import assert from "node:assert/strict";
import { BlockRepetitionDetector } from "./loop-detector.ts";

let passed = 0;
function test(name: string, fn: () => void) {
  fn();
  passed++;
  console.log(`  ok - ${name}`);
}

/** Feed text in small chunks to mimic streaming; return whether it tripped. */
function feed(text: string, chunkSize = 17): boolean {
  const d = new BlockRepetitionDetector();
  for (let i = 0; i < text.length; i += chunkSize) {
    if (d.push(text.slice(i, i + chunkSize))) return true;
  }
  return d.tripped;
}

// ── POSITIVE: the actual bug-report shape ──────────────────────────────────
// A heading + short numbered list, repeated verbatim many times. Each line is
// < 60 chars and the block is > 40 chars, so the old guards miss it.
const HELP_BLOCK =
  "How I can help instead:\n" +
  "1. Answer questions about the codebase\n" +
  "2. Write or edit code for you\n" +
  "3. Explain how a feature works\n\n";

test("trips on repeated 'How I can help instead' block (screenshot case)", () => {
  assert.equal(feed(HELP_BLOCK.repeat(12)), true);
});

test("trips on a repeated multi-line block at threshold (4 copies)", () => {
  // 4 copies should be enough; ensure it fires by ~that point.
  assert.equal(feed(HELP_BLOCK.repeat(4)), true);
});

test("trips on a repeated long single-line sentence (80+ chars)", () => {
  const line =
    "I'm sorry, but I cannot help with that request and you should try something else entirely.\n";
  assert.equal(feed(line.repeat(10)), true);
});

test("trips even with tiny streaming chunks (1 char at a time)", () => {
  assert.equal(feed(HELP_BLOCK.repeat(10), 1), true);
});

test("trips with minor whitespace drift between copies", () => {
  // Same block but trailing spaces vary slightly — within similarity tolerance.
  const a = HELP_BLOCK;
  const b = HELP_BLOCK.replace("Answer questions", "Answer  questions");
  assert.equal(feed((a + b + a + b + a + b + a + b).repeat(2)), true);
});

// ── NEGATIVE: legitimate content must NOT trip ──────────────────────────────

test("does NOT trip on a normal legitimate numbered list", () => {
  const list =
    "Here are the steps to set up the project:\n" +
    "1. Clone the repository from GitHub to your machine\n" +
    "2. Run npm install to pull down all dependencies\n" +
    "3. Copy .env.example to .env and fill in secrets\n" +
    "4. Run npm run db:push to create the SQLite tables\n" +
    "5. Start the dev server with npm run dev on port 5000\n" +
    "6. Open the app in your browser and log in\n" +
    "7. Verify the terminal and chat both connect over WS\n";
  assert.equal(feed(list), false);
});

test("does NOT trip on a normal prose paragraph", () => {
  const prose =
    "The agent loop streams tokens from the model and writes them to an " +
    "AgentStream buffer. Subscribers replay missed events and then receive " +
    "live tokens. When the loop finishes it marks the stream done and schedules " +
    "cleanup after a TTL. None of this text repeats, so the detector stays quiet.\n";
  assert.equal(feed(prose), false);
});

test("does NOT trip on a real code block", () => {
  const code =
    "```typescript\n" +
    "export function add(a: number, b: number): number {\n" +
    "  return a + b;\n" +
    "}\n" +
    "export function sub(a: number, b: number): number {\n" +
    "  return a - b;\n" +
    "}\n" +
    "export function mul(a: number, b: number): number {\n" +
    "  return a * b;\n" +
    "}\n" +
    "```\n";
  assert.equal(feed(code), false);
});

test("does NOT trip on repeated SHORT words / punctuation (left to char guard)", () => {
  // The unit is far below the block minimum; this detector must ignore it so it
  // doesn't duplicate the existing char-level guard (and never false-positives
  // on emphatic short repeats).
  assert.equal(feed("ok ok ok ok ok ok ok ok ok ok ok ok "), false);
  assert.equal(feed("......................................"), false);
  assert.equal(feed("ha ha ha ha ha ha ha ha ha ha ha ha "), false);
});

test("does NOT trip when a block repeats only twice", () => {
  // Two copies of a block is common and benign (e.g. a template echoed once).
  assert.equal(feed(HELP_BLOCK.repeat(2)), false);
});

test("does NOT trip on a markdown table", () => {
  const table =
    "| Name | Type | Default |\n" +
    "| ---- | ---- | ------- |\n" +
    "| temperature | number | 0.7 |\n" +
    "| topP | number | undefined |\n" +
    "| maxTokens | number | model-decided |\n" +
    "| stream | boolean | true |\n";
  assert.equal(feed(table), false);
});

console.log(`\n${passed} tests passed`);
