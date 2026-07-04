import type { ModelInfo } from "@schema-studio/core";

import { parseOpenAiCompatibleModels } from "./openaiModels.js";

/**
 * The default local endpoint: Ollama's OpenAI-compatible base URL. LM Studio (`:1234/v1`),
 * llama.cpp, and vLLM expose the same `/v1/chat/completions` + `/v1/models` surface, so the user
 * only changes this URL — the wire format is identical. Chosen as the default because Ollama is the
 * most common local runtime.
 */
export const LOCAL_DEFAULT_ENDPOINT = "http://localhost:11434/v1";

/**
 * No static catalog. Which models a local server can serve depends entirely on what the user has
 * pulled, so the picker is populated live from `GET {endpoint}/models` — there is nothing sensible
 * to hard-code. Kept as a named export so the provider registry reads like the others.
 */
export const LOCAL_MODEL_CATALOG: ModelInfo[] = [];

/**
 * Parse an OpenAI-compatible `GET /v1/models` list from a local runtime. Delegates to the shared
 * {@link parseOpenAiCompatibleModels} with NO family filter: whatever the user pulled is fair game
 * (the copilot's tool loop still requires a tool-capable model, but that is the user's choice).
 */
export function parseLocalModels(json: unknown): ModelInfo[] {
  return parseOpenAiCompatibleModels(json);
}
