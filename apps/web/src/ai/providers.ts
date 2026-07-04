import type { AiProvider, ModelInfo, TargetId } from "@schema-studio/core";

import { AnthropicBrowserProvider } from "./AnthropicBrowserProvider.js";
import { OpenAiBrowserProvider } from "./OpenAiBrowserProvider.js";
import { DEFAULT_MODEL, MODEL_CATALOG } from "./models.js";
import { OPENAI_DEFAULT_MODEL, OPENAI_MODEL_CATALOG } from "./openaiModels.js";

/**
 * The AI providers the app can talk to with a BYO key. `"local"` is deliberately absent — it
 * stays a disabled "Soon" segment in the UI until there's an implementation.
 */
export type ProviderId = "anthropic" | "openai";

/**
 * Everything the app needs to know about one provider, so no consumer hardcodes Anthropic:
 * display copy, the key-prefix used for soft validation, the console URL, the picker's default
 * model + static fallback catalog, and a factory that builds the concrete {@link AiProvider}.
 */
export type ProviderMeta = {
  id: ProviderId;
  label: string;
  /** Soft-validation prefix for the key input (e.g. "sk-ant-"). */
  keyPrefix: string;
  keyPlaceholder: string;
  keysUrl: string;
  defaultModel: string;
  /** Static fallback catalog for the model picker when the live list can't be fetched. */
  catalog: ModelInfo[];
  /** The top models to surface in the compact chat model picker (a curated shortlist). */
  featured: ModelInfo[];
  create(apiKey: string, model: string, target: TargetId): AiProvider;
};

export const PROVIDERS: Record<ProviderId, ProviderMeta> = {
  anthropic: {
    id: "anthropic",
    label: "Anthropic",
    keyPrefix: "sk-ant-",
    keyPlaceholder: "sk-ant-api03-…",
    keysUrl: "https://console.anthropic.com/settings/keys",
    defaultModel: DEFAULT_MODEL,
    catalog: MODEL_CATALOG,
    featured: [
      { id: "claude-opus-4-8", displayName: "Claude Opus 4.8" },
      { id: "claude-sonnet-4-6", displayName: "Claude Sonnet 4.6" },
    ],
    create: (apiKey, model, target) => new AnthropicBrowserProvider(apiKey, model, target),
  },
  openai: {
    id: "openai",
    label: "OpenAI",
    keyPrefix: "sk-",
    keyPlaceholder: "sk-…",
    keysUrl: "https://platform.openai.com/api-keys",
    defaultModel: OPENAI_DEFAULT_MODEL,
    catalog: OPENAI_MODEL_CATALOG,
    featured: [
      { id: "gpt-5", displayName: "GPT-5" },
      { id: "gpt-4.1", displayName: "GPT-4.1" },
      { id: "o3", displayName: "o3" },
    ],
    create: (apiKey, model, target) => new OpenAiBrowserProvider(apiKey, model, target),
  },
};

/** Stable ordered list of provider ids, for iterating segments/menus. */
export const PROVIDER_IDS: ProviderId[] = ["anthropic", "openai"];

/** Narrow an arbitrary string to a known {@link ProviderId}, defaulting to Anthropic. */
export function toProviderId(value: unknown): ProviderId {
  return value === "openai" || value === "anthropic" ? value : "anthropic";
}
