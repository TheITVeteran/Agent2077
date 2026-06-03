/**
 * Model Context Window Resolver (v16.74)
 *
 * Resolves the usable context window (in tokens) for a given model/endpoint and
 * reports HOW it was determined via a `source` indicator. This powers the
 * per-turn context-usage metadata and the frontend context gauge.
 *
 * Resolution order (highest confidence first):
 *   1. settings       — explicit user override (settingsStore "contextWindow.<modelId>" or global)
 *   2. model_metadata — preferred/loaded/max context length already stored on the Model row
 *   3. known_table    — match against a table of well-known model families
 *   4. provider_probe — short-timeout HTTP probe of the provider (LM Studio v0 API)
 *   5. fallback       — conservative default
 *
 * All HTTP probes are short-timeout and failure-safe: a probe that hangs, errors,
 * or times out simply falls through to the next strategy. We never block an LLM
 * request on this resolver.
 */
import { Endpoint, Model } from "../../shared/schema.js";
import { settingsStore } from "../storage.js";
import { isLocalProvider } from "./llm-client.js";

export type ContextWindowSource =
  | "settings"
  | "model_metadata"
  | "known_table"
  | "provider_probe"
  | "fallback";

export interface ContextWindowResult {
  /** Usable context window in tokens. */
  contextWindowTokens: number;
  /** How the value was determined. */
  source: ContextWindowSource;
  /** Optional human-readable detail (e.g. which field/table entry matched). */
  detail?: string;
}

/** Conservative fallback when nothing else resolves. */
export const FALLBACK_CONTEXT_WINDOW = 8192;

/**
 * Known model-name → context window table.
 * Keys are lowercase substrings matched against the model id. Order matters:
 * more specific entries should come before generic ones. These are the model's
 * NATIVE max windows; the budget layer applies its own safety margin.
 */
const KNOWN_MODELS: Array<{ match: string; tokens: number }> = [
  // OpenAI
  { match: "gpt-4.1", tokens: 1_047_576 },
  { match: "gpt-4o", tokens: 128_000 },
  { match: "gpt-4-turbo", tokens: 128_000 },
  { match: "gpt-4-32k", tokens: 32_768 },
  { match: "gpt-4", tokens: 8_192 },
  { match: "gpt-3.5-turbo-16k", tokens: 16_385 },
  { match: "gpt-3.5", tokens: 16_385 },
  { match: "o1", tokens: 200_000 },
  { match: "o3", tokens: 200_000 },
  // Anthropic
  { match: "claude-3", tokens: 200_000 },
  { match: "claude-opus", tokens: 200_000 },
  { match: "claude-sonnet", tokens: 200_000 },
  { match: "claude-haiku", tokens: 200_000 },
  { match: "claude-2", tokens: 100_000 },
  // Google
  { match: "gemini-1.5-pro", tokens: 2_000_000 },
  { match: "gemini-1.5", tokens: 1_000_000 },
  { match: "gemini-2", tokens: 1_000_000 },
  { match: "gemini", tokens: 32_768 },
  // Meta Llama
  { match: "llama-3.1", tokens: 131_072 },
  { match: "llama-3.2", tokens: 131_072 },
  { match: "llama-3.3", tokens: 131_072 },
  { match: "llama-4", tokens: 1_000_000 },
  { match: "llama-3", tokens: 8_192 },
  { match: "llama-2", tokens: 4_096 },
  // Mistral
  { match: "mistral-large", tokens: 131_072 },
  { match: "mistral-nemo", tokens: 131_072 },
  { match: "mixtral", tokens: 32_768 },
  { match: "mistral", tokens: 32_768 },
  { match: "codestral", tokens: 32_768 },
  // Qwen
  { match: "qwen3", tokens: 131_072 },
  { match: "qwen2.5", tokens: 131_072 },
  { match: "qwen2", tokens: 32_768 },
  { match: "qwen", tokens: 32_768 },
  // DeepSeek
  { match: "deepseek-v3", tokens: 131_072 },
  { match: "deepseek-r1", tokens: 131_072 },
  { match: "deepseek-coder", tokens: 131_072 },
  { match: "deepseek", tokens: 65_536 },
  // MiniMax
  { match: "minimax-m2", tokens: 204_800 },
  { match: "minimax", tokens: 204_800 },
  // Misc local families
  { match: "gemma-2", tokens: 8_192 },
  { match: "gemma-3", tokens: 131_072 },
  { match: "gemma", tokens: 8_192 },
  { match: "phi-3", tokens: 131_072 },
  { match: "phi-4", tokens: 16_384 },
  { match: "phi", tokens: 4_096 },
  { match: "command-r", tokens: 131_072 },
  { match: "yi-", tokens: 200_000 },
  { match: "nemotron", tokens: 131_072 },
];

/** Parse a positive integer from a settings string, or null. */
function parsePositiveInt(raw: string | null | undefined): number | null {
  if (!raw) return null;
  const n = parseInt(raw, 10);
  return !isNaN(n) && n > 0 ? n : null;
}

/** Read a setting without ever throwing (DB not ready, missing table, etc.). */
function safeGetSetting(key: string): string | null {
  try {
    return settingsStore.get(key);
  } catch {
    return null;
  }
}

/** Look up a model id against the known-model table. */
export function lookupKnownContextWindow(modelId: string): number | null {
  const id = (modelId || "").toLowerCase();
  for (const entry of KNOWN_MODELS) {
    if (id.includes(entry.match)) return entry.tokens;
  }
  return null;
}

/**
 * Short-timeout, failure-safe probe of a provider for the loaded model's context
 * length. Currently supports LM Studio's v0 API (`/api/v0/models`), which reports
 * `loaded_context_length` / `max_context_length`. Returns null on any failure.
 */
async function probeProviderContextWindow(
  endpoint: Endpoint,
  modelId: string,
  timeoutMs: number,
): Promise<number | null> {
  // Only LM Studio exposes per-model context metadata via a cheap probe.
  if (!isLocalProvider(endpoint)) return null;
  const base = (endpoint.url || "").replace(/\/v1\/?$/, "");
  if (!base) return null;
  try {
    const res = await fetch(`${base}/api/v0/models`, {
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return null;
    const data = await res.json();
    const models = Array.isArray(data) ? data : (data.data || []);
    const match = models.find((m: any) => (m.id || m.path) === modelId);
    if (!match) return null;
    const loaded = parsePositiveInt(String(match.loaded_context_length ?? ""));
    const max = parsePositiveInt(String(match.max_context_length ?? ""));
    return loaded || max || null;
  } catch {
    // Timeout, network error, or abort — never block the caller.
    return null;
  }
}

/**
 * Resolve the context window for a model on an endpoint.
 *
 * @param model     the Model row (may carry metadata-sourced context lengths)
 * @param endpoint  the endpoint (used only for optional probing)
 * @param opts.allowProbe  whether to attempt an HTTP probe (default false — keep
 *                         the hot path non-blocking; callers that can tolerate a
 *                         short await opt in)
 * @param opts.probeTimeoutMs  probe timeout (default 1500ms)
 */
export async function resolveContextWindow(
  model: Model | undefined,
  endpoint?: Endpoint,
  opts: { allowProbe?: boolean; probeTimeoutMs?: number } = {},
): Promise<ContextWindowResult> {
  const modelId = model?.modelId || "";

  // 1. Settings override — per-model first, then global.
  const perModel = model ? safeGetSetting(`contextWindow.${modelId}`) : null;
  const globalOverride = safeGetSetting("contextWindow.default");
  const settingVal = parsePositiveInt(perModel) ?? parsePositiveInt(globalOverride);
  if (settingVal) {
    return {
      contextWindowTokens: settingVal,
      source: "settings",
      detail: perModel ? `contextWindow.${modelId}` : "contextWindow.default",
    };
  }

  // 2. Model metadata already on the row.
  if (model) {
    const preferred = model.preferredContextLength;
    const loaded = model.loadedContextLength;
    const max = model.maxContextLength;
    const metaVal = (preferred && preferred > 0 && preferred)
      || (loaded && loaded > 0 && loaded)
      || (max && max > 0 && max)
      || null;
    if (metaVal) {
      const field = preferred && preferred > 0 ? "preferredContextLength"
        : loaded && loaded > 0 ? "loadedContextLength"
        : "maxContextLength";
      return { contextWindowTokens: metaVal, source: "model_metadata", detail: field };
    }
  }

  // 3. Known-model table.
  const known = lookupKnownContextWindow(modelId);
  if (known) {
    return { contextWindowTokens: known, source: "known_table", detail: modelId };
  }

  // 4. Optional short-timeout provider probe.
  if (opts.allowProbe && endpoint && modelId) {
    const probed = await probeProviderContextWindow(
      endpoint,
      modelId,
      opts.probeTimeoutMs ?? 1500,
    );
    if (probed) {
      return { contextWindowTokens: probed, source: "provider_probe", detail: "lmstudio_v0" };
    }
  }

  // 5. Conservative fallback.
  return { contextWindowTokens: FALLBACK_CONTEXT_WINDOW, source: "fallback" };
}

/**
 * Synchronous resolver — same as resolveContextWindow but skips the HTTP probe.
 * Safe for the hot path. Returns the best non-probe answer.
 */
export function resolveContextWindowSync(
  model: Model | undefined,
  _endpoint?: Endpoint,
): ContextWindowResult {
  const modelId = model?.modelId || "";

  const perModel = model ? safeGetSetting(`contextWindow.${modelId}`) : null;
  const globalOverride = safeGetSetting("contextWindow.default");
  const settingVal = parsePositiveInt(perModel) ?? parsePositiveInt(globalOverride);
  if (settingVal) {
    return {
      contextWindowTokens: settingVal,
      source: "settings",
      detail: perModel ? `contextWindow.${modelId}` : "contextWindow.default",
    };
  }

  if (model) {
    const preferred = model.preferredContextLength;
    const loaded = model.loadedContextLength;
    const max = model.maxContextLength;
    const metaVal = (preferred && preferred > 0 && preferred)
      || (loaded && loaded > 0 && loaded)
      || (max && max > 0 && max)
      || null;
    if (metaVal) {
      const field = preferred && preferred > 0 ? "preferredContextLength"
        : loaded && loaded > 0 ? "loadedContextLength"
        : "maxContextLength";
      return { contextWindowTokens: metaVal, source: "model_metadata", detail: field };
    }
  }

  const known = lookupKnownContextWindow(modelId);
  if (known) {
    return { contextWindowTokens: known, source: "known_table", detail: modelId };
  }

  return { contextWindowTokens: FALLBACK_CONTEXT_WINDOW, source: "fallback" };
}

/** Characters-per-token heuristic, matched to agent-loop's estimator. */
export const CHARS_PER_TOKEN = 4;

/**
 * Cheap prompt-token estimate for an array of chat-message-like objects.
 * Mirrors agent-loop's estimateTokens so the gauge stays consistent with the
 * compaction layer. Counts message content + serialized tool_calls.
 */
export function estimatePromptTokens(
  messages: Array<{ content?: string | null; tool_calls?: any }>,
): number {
  let chars = 0;
  for (const m of messages) {
    const c = m.content;
    chars += typeof c === "string" ? c.length : (c == null ? 0 : JSON.stringify(c).length);
    if (m.tool_calls) chars += JSON.stringify(m.tool_calls).length;
  }
  return Math.ceil(chars / CHARS_PER_TOKEN);
}

export interface ContextUsage {
  estimatedPromptTokens: number;
  contextWindowTokens: number;
  contextUsedPercent: number;
  source: ContextWindowSource;
  detail?: string;
  toolSchemaTokens?: number;
}

/**
 * Build a per-turn context-usage payload from an estimate + window result.
 * `contextUsedPercent` is rounded to one decimal and clamped to [0, 100+] (we
 * do not cap above 100 so the UI can show a true overflow in the red band).
 */
export function buildContextUsage(
  estimatedPromptTokens: number,
  window: ContextWindowResult,
  toolSchemaTokens?: number,
): ContextUsage {
  const pct = window.contextWindowTokens > 0
    ? (estimatedPromptTokens / window.contextWindowTokens) * 100
    : 0;
  return {
    estimatedPromptTokens,
    contextWindowTokens: window.contextWindowTokens,
    contextUsedPercent: Math.round(pct * 10) / 10,
    source: window.source,
    detail: window.detail,
    ...(toolSchemaTokens != null ? { toolSchemaTokens } : {}),
  };
}
