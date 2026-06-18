/**
 * Per-conversation document canvas smoke test (v16.74.24).
 *
 * Pins the contract of the chat document canvas added in v16.74.23:
 *   - storage round-trip + per-conversation isolation
 *   - documentStore.upsert is create-or-replace, scoped to a conversation
 *   - the agent tools (document_read / document_write / document_patch)
 *     operate ONLY on context.conversationId (never an arbitrary id/path)
 *   - tool selection picks the doc tools for doc-editing intents while casual
 *     chat still suppresses tools (tool_choice "none")
 *   - the download route's filename derivation
 *
 * Run with: npx tsx script/test-document-canvas.ts
 */
import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

process.env.AGENT2077_DB_PATH = join(mkdtempSync(join(tmpdir(), "a2077-doc-")), "test.db");

const { bootstrapSchema, initFTS, runMigrations, initNewTables } = await import("../server/db.js");
bootstrapSchema();
initFTS();
runMigrations();
initNewTables();

const { conversationStore, documentStore } = await import("../server/storage.js");
await import("../server/tools/document-tools.js");
const { executeTool } = await import("../server/tools/registry.js");
const { routeRequest, decideToolChoice } = await import("../server/lib/request-router.js");
const { selectTools } = await import("../server/lib/tool-selector.js");
const { getAllTools } = await import("../server/tools/registry.js");

let failures = 0;
function check(label: string, ok: boolean, detail?: string) {
  const mark = ok ? "PASS" : "FAIL";
  console.log(`[${mark}] ${label}${detail ? " — " + detail : ""}`);
  if (!ok) { failures++; process.exitCode = 1; }
}

const ctx = (conversationId: number) => ({ conversationId, requestId: `req-${conversationId}` });

// ── 1. Storage round-trip + per-conversation isolation ──────────────────────
const convA = conversationStore.create({ title: "Chat A", systemPrompt: null });
const convB = conversationStore.create({ title: "Chat B", systemPrompt: null });

const docA = documentStore.upsert(convA.id, { title: "Notes A", content: "# A\n\nhello" });
check("upsert creates a document", !!docA && docA.id > 0);
check("document is scoped to its conversation", docA.conversationId === convA.id);

documentStore.upsert(convB.id, { title: "Notes B", content: "# B\n\nworld" });

const reA = documentStore.getByConversation(convA.id);
const reB = documentStore.getByConversation(convB.id);
check("conversation A has its own doc", reA?.content === "# A\n\nhello", reA?.content);
check("conversation B has its own doc", reB?.content === "# B\n\nworld", reB?.content);
check("docs are isolated (A != B)", reA?.id !== reB?.id);

// upsert is create-or-replace (one doc per conversation, not a second row)
const docA2 = documentStore.upsert(convA.id, { content: "# A2" });
check("upsert replaces existing doc (same id)", docA2.id === docA.id, `${docA2.id} vs ${docA.id}`);
check("upsert preserves title when only content given", docA2.title === "Notes A", docA2.title);
check("upsert updated content", docA2.content === "# A2");

// ── 2. Agent tools operate on the CURRENT conversation only ─────────────────
// document_write on conv A must not touch conv B.
const wrote = await executeTool("document_write", { content: "written by tool", title: "Tool Doc" }, ctx(convA.id));
check("document_write succeeds", wrote.success, wrote.output);
check("document_write only affected conv A", documentStore.getByConversation(convA.id)?.content === "written by tool");
check("document_write did NOT touch conv B", documentStore.getByConversation(convB.id)?.content === "# B\n\nworld");

// document_read returns THIS conversation's doc, not another's.
const readA = await executeTool("document_read", {}, ctx(convA.id));
check("document_read returns conv A content", readA.output.includes("written by tool"));
check("document_read does not leak conv B content", !readA.output.includes("world"));

// document_patch append / prepend / replace.
const ap = await executeTool("document_patch", { mode: "append", text: "appended-line" }, ctx(convA.id));
check("document_patch append succeeds", ap.success, ap.output);
check("append added text to end", documentStore.getByConversation(convA.id)?.content.endsWith("appended-line"));

const pp = await executeTool("document_patch", { mode: "prepend", text: "top-line" }, ctx(convA.id));
check("document_patch prepend succeeds", pp.success);
check("prepend added text to top", documentStore.getByConversation(convA.id)?.content.startsWith("top-line"));

const rp = await executeTool("document_patch", { mode: "replace", find: "written by tool", text: "REPLACED" }, ctx(convA.id));
check("document_patch replace succeeds", rp.success);
check("replace swapped the snippet", documentStore.getByConversation(convA.id)?.content.includes("REPLACED"));

const rpMiss = await executeTool("document_patch", { mode: "replace", find: "nonexistent-snippet", text: "x" }, ctx(convA.id));
check("replace with missing snippet fails gracefully", !rpMiss.success && rpMiss.output.includes("Could not find"));

// document_read on an empty/new conversation says it's empty (no crash, no leak).
const convC = conversationStore.create({ title: "Chat C", systemPrompt: null });
const readC = await executeTool("document_read", {}, ctx(convC.id));
check("document_read on empty conv reports empty", readC.success && readC.output.toLowerCase().includes("empty"));

// SAFETY: tools take no path / documentId arg — arbitrary access is impossible.
const writeDef = getAllTools().get("document_write")!.definition.function.parameters as any;
check("document_write exposes no path/id param",
  !("path" in (writeDef.properties || {})) && !("documentId" in (writeDef.properties || {})));

// ── 3. Tool selection: doc intent selects doc tools; casual stays suppressed ─
const allTools = getAllTools();

const fakeModel = { modelId: "test/model", contextWindow: 32000 } as any;
function selectFor(message: string) {
  const route = routeRequest(message);
  return {
    route,
    sel: selectTools({
      lastUserMessage: message,
      allTools,
      route,
      model: fakeModel,
      modelSize: "large",
      smartSelectionEnabled: true,
    } as any),
  };
}

{
  const { route, sel } = selectFor("write this up in the document");
  check("doc-edit intent routes to document", route.route === "document", route.route);
  check("doc route force-includes document_write", route.forceInclude.includes("document_write"));
  check("selector picks document_write for doc intent", sel.selectedNames.has("document_write"));
  check("doc intent is not suppressed (tool_choice auto)", decideToolChoice("write this up in the document") === "auto");
}

{
  const { sel } = selectFor("what's in the doc?");
  check("'what's in the doc' selects document_read", sel.selectedNames.has("document_read"));
}

// Casual chat must NOT route to document and MUST suppress tools.
for (const casual of ["hi", "how's it going?", "lol nice"]) {
  const route = routeRequest(casual);
  check(`casual "${casual}" not routed to document`, route.route !== "document", route.route);
  check(`casual "${casual}" suppresses tools`, decideToolChoice(casual) === "none");
}

// ── 3b. Regression: doc-intent phrasings route to document (v16.74.23 fix) ──
// Before the fix these fell through to `unknown`, where the selector loaded
// file/code-write tools and the agent wrote workspace files instead of the
// chat canvas. Each must route to `document` and stay tool_choice "auto".
for (const phrase of [
  "write up a doc",
  "write this up in a doc",
  "make a document for this",
  "add this to the doc",
  "draft a doc with me",
  "rewrite the doc",
  "can you write up a document summarizing our discussion",
]) {
  const route = routeRequest(phrase);
  check(`doc phrase "${phrase}" routes to document`, route.route === "document", route.route);
  check(`doc phrase "${phrase}" is not suppressed`, decideToolChoice(phrase) === "auto");
}

// Pure doc intent must select the document tools and NOT surface file-write
// tools that would let the model write to the workspace instead of the canvas.
{
  const { sel } = selectFor("write up a doc summarizing this");
  check("doc intent selects document_write", sel.selectedNames.has("document_write"));
  check("doc intent does NOT select write_file",
    !sel.selectedNames.has("write_file") && !sel.selectedNames.has("create_file"),
    [...sel.selectedNames].join(","));
}

// ── 3c. Regression: explicit file/workspace/path intent does NOT route doc ──
// These mention a real file/path/workspace/export, so the document route is
// vetoed and the turn must fall through to file/code-write tooling.
for (const phrase of [
  "save this to workspace/foo.md",
  "create a file",
  "write a markdown file in the project",
  "export as a file",
  "rewrite the doc as a markdown file in the project",
]) {
  const route = routeRequest(phrase);
  check(`explicit-file "${phrase}" is NOT routed to document`, route.route !== "document", route.route);
}

// When BOTH doc and explicit-file language are present, file intent wins.
{
  const route = routeRequest("rewrite the doc as a markdown file in the project");
  check("doc+file phrase vetoes document route", route.route !== "document", route.route);
}

// ── 4. Download filename derivation (mirrors routes.ts) ─────────────────────
function downloadName(title: string, format: string) {
  const ext = format === "text" ? "txt" : "md";
  const safe = (title || "document").replace(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 80) || "document";
  return `${safe}.${ext}`;
}
check("download name sanitizes + .md", downloadName("My Report!", "markdown") === "My_Report_.md");
check("download name uses .txt for text format", downloadName("plain", "text") === "plain.txt");
check("download name falls back to 'document'", downloadName("", "markdown") === "document.md");

console.log(failures === 0 ? "\nAll document-canvas checks passed." : `\n${failures} check(s) failed.`);
