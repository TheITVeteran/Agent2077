/**
 * Self-dev reasoning/thinking wiring test.
 *
 * The user reported the dev (self-dev) chat lacked the thinking viewer and a way
 * to choose a thinking mode. This test pins, by static source inspection
 * (no React render needed), the full self-dev reasoning/thinking contract:
 *
 *   UI (client/src/pages/self-dev.tsx):
 *     1. imports + renders <ThinkingPanel> for streamed reasoning,
 *     2. has a reasoning-mode lightbulb selector built from enabled models,
 *     3. sends reasoningModeId + reasoningModeLabel in the /api/self-dev/chat body,
 *     4. handles "thinking" events in BOTH bespoke reconnect loops (so thinking
 *        survives navigate-away/back and after-reset resume), and resets it.
 *
 *   Server (server/routes.ts):
 *     5. /api/self-dev/chat reads reasoningModeId/Label, resolves a profile, and
 *        passes `reasoning` into runAgentLoop (mirrors /api/chat).
 *
 *   Presets (client/src/pages/settings.tsx):
 *     6. DeepSeek V4 High + Max presets exist with the correct extra_body shape.
 *
 * Run with: npx tsx script/test-selfdev-reasoning.ts
 */
import { readFileSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const selfDev = readFileSync(join(root, "client/src/pages/self-dev.tsx"), "utf8");
const routes = readFileSync(join(root, "server/routes.ts"), "utf8");
const settings = readFileSync(join(root, "client/src/pages/settings.tsx"), "utf8");

let failures = 0;
function check(label: string, ok: boolean, detail?: string) {
  const mark = ok ? "PASS" : "FAIL";
  console.log(`[${mark}] ${label}${detail ? " — " + detail : ""}`);
  if (!ok) { failures++; process.exitCode = 1; }
}

// ── 1. ThinkingPanel imported + rendered in self-dev ────────────────────────
check("self-dev imports ThinkingPanel",
  /import \{ ThinkingPanel \} from "@\/components\/ThinkingPanel"/.test(selfDev));
check("self-dev renders <ThinkingPanel content={thinkingContent} ...>",
  /<ThinkingPanel\s+content=\{thinkingContent\}\s+streaming=\{streaming\}\s+compact/.test(selfDev));

// ── 2. Reasoning-mode selector present ──────────────────────────────────────
check("self-dev has a reasoning-mode lightbulb trigger",
  /data-testid="selfdev-toggle-reasoning-mode"/.test(selfDev));
check("self-dev offers an Off / default option",
  /data-testid="selfdev-reasoning-mode-off"/.test(selfDev));
check("self-dev builds reasoningModes from enabled models' reasoningProfiles",
  /reasoningModes\s*=\s*useMemo/.test(selfDev) && /!m\?\.isEnabled \|\| !m\?\.reasoningProfiles/.test(selfDev));
check("self-dev tracks selected reasoningModeId state",
  /const \[reasoningModeId, setReasoningModeId\] = useState/.test(selfDev));

// ── 3. Selected mode is sent in the send body ───────────────────────────────
check("self-dev send body includes reasoningModeId",
  /url: "\/api\/self-dev\/chat"[\s\S]*?reasoningModeId: reasoningModeId \|\| undefined/.test(selfDev));
check("self-dev send body includes reasoningModeLabel",
  /url: "\/api\/self-dev\/chat"[\s\S]*?reasoningModeLabel: activeReasoningLabel \|\| undefined/.test(selfDev));

// ── 4. Thinking handled in reconnect loops + reset ──────────────────────────
const thinkingHandlers = selfDev.match(/ev\.type === "thinking"\)?\s*(\{)?\s*setThinkingContent\(p => p \+ \(ev\.content \?\? ""\)\)/g) ?? [];
check("self-dev handles 'thinking' events in BOTH reconnect loops",
  thinkingHandlers.length >= 2, `found ${thinkingHandlers.length}`);
check("self-dev resets thinkingContent on reconnect/resume",
  (selfDev.match(/setThinkingContent\(""\)/g) ?? []).length >= 2);

// ── 5. Server route resolves + forwards reasoning ───────────────────────────
const selfDevRoute = routes.slice(routes.indexOf('app.post("/api/self-dev/chat"'));
check("/api/self-dev/chat reads reasoningModeId from body",
  /const reasoningModeId: string \| undefined = req\.body\.reasoningModeId/.test(selfDevRoute));
check("/api/self-dev/chat resolves a reasoning profile",
  /reasoning = resolveReasoningProfile\(routing\.model as any, reasoningModeId, reasoningModeLabel\)/.test(selfDevRoute));
check("/api/self-dev/chat passes reasoning into runAgentLoop",
  /runAgentLoop\(\{[\s\S]*?reasoning,[\s\S]*?\}\)/.test(selfDevRoute));

// ── 6. DeepSeek presets present with correct shape ──────────────────────────
check("settings defines a DeepSeek V4 High preset",
  /label: "DeepSeek V4 High"/.test(settings));
check("settings defines a DeepSeek V4 Max preset",
  /label: "DeepSeek V4 Max"/.test(settings));
check("DeepSeek presets use custom_json + chat_template_kwargs",
  /strategy: "custom_json"[\s\S]*?chat_template_kwargs: \{ thinking: true, preserve_thinking: true, reasoning_effort: "high" \}/.test(settings) &&
  /chat_template_kwargs: \{ thinking: true, preserve_thinking: true, reasoning_effort: "max" \}/.test(settings));
check("DeepSeek Max preset notes the large-context recommendation (>= 393216)",
  /393216/.test(settings));

console.log(failures === 0 ? "\nAll self-dev reasoning/thinking checks passed." : `\n${failures} check(s) failed.`);
