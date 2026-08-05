import type { ModelInfo } from "@grafture/core";

/**
 * The model used when no preference is saved. Kept on the Sonnet tier to preserve the app's
 * original cost/behavior; the Settings picker is how users opt into Opus/Fable tiers.
 */
export const DEFAULT_MODEL = "claude-sonnet-5";

/**
 * Curated fallback catalog, shown when the live Models API can't be reached (no key, offline, or
 * the request fails). The picker is scoped to the Sonnet and Opus families, so only those appear
 * here and the live list is filtered to match ({@link isSelectableModel}).
 */
export const MODEL_CATALOG: ModelInfo[] = [
  { id: "claude-opus-5", displayName: "Claude Opus 5", maxInputTokens: 1_000_000 },
  { id: "claude-sonnet-5", displayName: "Claude Sonnet 5", maxInputTokens: 1_000_000 },
  { id: "claude-opus-4-8", displayName: "Claude Opus 4.8", maxInputTokens: 1_000_000 },
  { id: "claude-sonnet-4-6", displayName: "Claude Sonnet 4.6", maxInputTokens: 1_000_000 },
];

/** The picker only offers Sonnet and Opus; everything else (Haiku, Fable, …) is filtered out. */
export function isSelectableModel(id: string): boolean {
  return id.startsWith("claude-sonnet") || id.startsWith("claude-opus");
}

/** Shape of one entry in the Anthropic `GET /v1/models` response `data` array (fields we read). */
type RawModel = {
  id?: unknown;
  display_name?: unknown;
  created_at?: unknown;
  max_input_tokens?: unknown;
  max_tokens?: unknown;
};

/** Shape of one page of the Anthropic `GET /v1/models` list response. */
export type ModelsPage = {
  models: ModelInfo[];
  hasMore: boolean;
  lastId: string | undefined;
};

function toModelInfo(raw: unknown): ModelInfo | null {
  if (typeof raw !== "object" || raw === null) {
    return null;
  }
  const entry = raw as RawModel;
  if (typeof entry.id !== "string" || !entry.id) {
    return null;
  }
  // Scope the picker to the Sonnet and Opus families.
  if (!isSelectableModel(entry.id)) {
    return null;
  }
  return {
    id: entry.id,
    displayName: typeof entry.display_name === "string" ? entry.display_name : entry.id,
    ...(typeof entry.created_at === "string" ? { createdAt: entry.created_at } : {}),
    ...(typeof entry.max_input_tokens === "number"
      ? { maxInputTokens: entry.max_input_tokens }
      : {}),
    ...(typeof entry.max_tokens === "number" ? { maxOutputTokens: entry.max_tokens } : {}),
  };
}

/** Parse one page of the Models list response into `ModelInfo`s plus the cursor for the next page. */
export function parseModelsPage(json: unknown): ModelsPage {
  const body = (json ?? {}) as { data?: unknown; has_more?: unknown; last_id?: unknown };
  const data = Array.isArray(body.data) ? body.data : [];
  const models = data
    .map((entry) => toModelInfo(entry))
    .filter((model): model is ModelInfo => model !== null);
  return {
    models,
    hasMore: body.has_more === true,
    lastId: typeof body.last_id === "string" ? body.last_id : undefined,
  };
}

/**
 * Merge the live model list with the static fallback, de-duplicated by id with the live entry
 * winning. The fallback fills in any current model the API didn't return (or all of them when the
 * fetch failed), so the picker always offers the known tiers.
 */
export function mergeModels(
  fetched: ModelInfo[],
  fallback: ModelInfo[] = MODEL_CATALOG,
): ModelInfo[] {
  const seen = new Set(fetched.map((model) => model.id));
  return [...fetched, ...fallback.filter((model) => !seen.has(model.id))];
}
