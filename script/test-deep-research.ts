/**
 * Deep Research toggle smoke tests (v16.74):
 *  - request-router: deepResearch flag forces the deep_research route and
 *    pulls in the web/browse tool set via forceInclude
 *  - request-router: route is NEVER inferred from text alone (toggle-only)
 *  - tool-selector: deep_research route selects the research surface + the
 *    forced web tools, and never leaks deploy/shell tools
 *  - tool-selector: shouldIncludeDeepResearchModule gates only on the route
 *
 * Run with: npx tsx script/test-deep-research.ts
 */
import { routeRequest } from "../server/lib/request-router.js";
import { selectTools, shouldIncludeDeepResearchModule } from "../server/lib/tool-selector.js";
import type { ToolHandler } from "../server/tools/registry.js";

function mockHandler(name: string, category = "search"): ToolHandler {
  return {
    category: category as any,
    definition: {
      type: "function",
      function: {
        name,
        description: `mock ${name}`,
        parameters: { type: "object", properties: {}, required: [] },
      },
    },
    async execute() { return { success: true, output: "" }; },
  };
}

const ALL_NAMES = [
  "read_file", "write_file", "edit_file", "list_files", "search_files",
  "shell_command", "execute_code", "deploy_app", "stop_app",
  "web_search", "fetch_url", "browse_url", "browse_search", "browse_extract", "browse_screenshot",
  "memory_recall", "memory_store", "skill_list", "skill_view",
  "session_search", "tool_list", "tool_search",
];
const allTools = new Map<string, ToolHandler>();
for (const n of ALL_NAMES) allTools.set(n, mockHandler(n));

let failures = 0;
function check(label: string, ok: boolean, detail?: string) {
  const mark = ok ? "PASS" : "FAIL";
  console.log(`[${mark}] ${label}${detail ? " — " + detail : ""}`);
  if (!ok) { failures++; process.exitCode = 1; }
}

// ── Router: toggle forces the deep_research route ──────────────────────────
{
  const r = routeRequest("what is the best GPU for local LLMs?", { deepResearch: true });
  check("router: deepResearch flag → deep_research", r.route === "deep_research", `got ${r.route}`);
  check("router: deep_research confidence is 1", r.confidence === 1);
  check("router: deep_research forceInclude web_search", r.forceInclude.includes("web_search"));
  check("router: deep_research forceInclude browse_url", r.forceInclude.includes("browse_url"));
}
{
  // The override wins even over text that would otherwise route elsewhere.
  const r = routeRequest("fix the login bug in auth.ts", { deepResearch: true });
  check("router: flag overrides code_write text", r.route === "deep_research", `got ${r.route}`);
}
{
  // Deep research is NEVER inferred from text — only the flag turns it on.
  const r = routeRequest("do a deep research report on quantum computing");
  check("router: 'deep research' text alone does NOT trigger route", r.route !== "deep_research", `got ${r.route}`);
}
{
  // Absent flag behaves exactly as before.
  const r = routeRequest("search the web for RTX 5060 reviews");
  check("router: no flag → normal research route", r.route === "research", `got ${r.route}`);
}

// ── Selector: deep_research route picks the research surface ───────────────
{
  const sel = selectTools({
    allTools,
    taskType: "research",
    model: { modelId: "qwen3-122b", supportsToolCalling: true } as any,
    modelSize: "large",
    lastUserMessage: "compare framework options",
    route: routeRequest("compare framework options", { deepResearch: true }),
  });
  check("selector deep_research: has web_search", sel.selectedNames.has("web_search"));
  check("selector deep_research: has fetch_url", sel.selectedNames.has("fetch_url"));
  check("selector deep_research: has browse_url", sel.selectedNames.has("browse_url"));
  check("selector deep_research: has browse_search", sel.selectedNames.has("browse_search"));
  check("selector deep_research: includes memory_store for interim findings", sel.selectedNames.has("memory_store"));
  check("selector deep_research: no deploy_app leaked", !sel.selectedNames.has("deploy_app"));
  check("selector deep_research: no shell_command leaked", !sel.selectedNames.has("shell_command"));
}

// ── Prompt-module gate ─────────────────────────────────────────────────────
{
  check("module: ON for deep_research route",
    shouldIncludeDeepResearchModule({ route: "deep_research", confidence: 1, reasons: [], preferCategories: [], forceInclude: [] }) === true);
  check("module: OFF for research route",
    shouldIncludeDeepResearchModule({ route: "research", confidence: 0.5, reasons: [], preferCategories: [], forceInclude: [] }) === false);
  check("module: OFF when no route", shouldIncludeDeepResearchModule(undefined) === false);
}

if (failures > 0) {
  console.error(`\n${failures} TEST(S) FAILED`);
  process.exit(1);
}
console.log("\nAll Deep Research smoke tests passed.");
