import type { ModelInfo } from "@schema-studio/core";

/**
 * The OpenAI model used when no preference is saved. A capable, current chat model; the Settings
 * picker is how users opt into other tiers (reasoning models, mini variants).
 */
export const OPENAI_DEFAULT_MODEL = "gpt-4.1";

/**
 * Curated fallback catalog, shown when the live Models API can't be reached (no key, offline, or
 * the request fails). OpenAI's list response carries no display names or token counts, so the
 * picker leans on this static list for nice labels; the live list ({@link parseOpenAiModelsPage})
 * is filtered to the same chat-capable families ({@link isSelectableOpenAiModel}).
 */
export const OPENAI_MODEL_CATALOG: ModelInfo[] = [
  { id: "gpt-5", displayName: "GPT-5" },
  { id: "gpt-4.1", displayName: "GPT-4.1" },
  { id: "gpt-4o", displayName: "GPT-4o" },
  { id: "o3", displayName: "o3" },
  { id: "o4-mini", displayName: "o4-mini" },
];

/**
 * The picker only offers chat/reasoning families we support; embeddings, audio, image, and
 * moderation models are filtered out. Deliberately prefix-based so newly released point versions
 * (e.g. `gpt-4.1-2025-…`) surface without a code change.
 */
export function isSelectableOpenAiModel(id: string): boolean {
  return (
    (id.startsWith("gpt-") || id.startsWith("o1") || id.startsWith("o3") || id.startsWith("o4")) &&
    // Exclude non-chat gpt-* variants that share the prefix.
    !id.includes("audio") &&
    !id.includes("realtime") &&
    !id.includes("transcribe") &&
    !id.includes("tts") &&
    !id.includes("image") &&
    !id.includes("search") &&
    !id.includes("embedding")
  );
}

/** Shape of one entry in an OpenAI-compatible `GET /v1/models` response `data` array. */
type RawModel = {
  id?: unknown;
  created?: unknown;
};

function toModelInfo(raw: unknown, isSelectable?: (id: string) => boolean): ModelInfo | null {
  if (typeof raw !== "object" || raw === null) {
    return null;
  }
  const entry = raw as RawModel;
  if (typeof entry.id !== "string" || !entry.id) {
    return null;
  }
  if (isSelectable && !isSelectable(entry.id)) {
    return null;
  }
  return {
    id: entry.id,
    // These endpoints report no display name — the id is the friendly-enough label.
    displayName: entry.id,
    // `created` is a Unix timestamp (seconds); normalize to ISO like the Anthropic catalog.
    ...(typeof entry.created === "number"
      ? { createdAt: new Date(entry.created * 1000).toISOString() }
      : {}),
  };
}

/**
 * Parse an OpenAI-compatible `GET /v1/models` list into `ModelInfo`s, newest-first. Shared by the
 * hosted OpenAI provider and the local-runtime provider, which speak the same list shape. Pass an
 * `isSelectable` predicate to filter by model family (OpenAI does; local deliberately doesn't).
 */
export function parseOpenAiCompatibleModels(
  json: unknown,
  isSelectable?: (id: string) => boolean,
): ModelInfo[] {
  const body = (json ?? {}) as { data?: unknown };
  const data = Array.isArray(body.data) ? body.data : [];
  const models = data
    .map((entry) => toModelInfo(entry, isSelectable))
    .filter((model): model is ModelInfo => model !== null);
  // Newest first when timestamps are present; stable otherwise.
  return models.sort((a, b) => (b.createdAt ?? "").localeCompare(a.createdAt ?? ""));
}

/**
 * Parse the OpenAI `GET /v1/models` list, filtered to the chat/reasoning families we support
 * ({@link isSelectableOpenAiModel}). Non-chat models (embeddings, audio, image) are dropped.
 */
export function parseOpenAiModels(json: unknown): ModelInfo[] {
  return parseOpenAiCompatibleModels(json, isSelectableOpenAiModel);
}
