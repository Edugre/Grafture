import { DEFAULT_TARGET, type TargetId } from "@schema-studio/core";

import { OpenAiCompatibleProvider } from "./openaiCompatible.js";
import { OPENAI_DEFAULT_MODEL, parseOpenAiModels } from "./openaiModels.js";

// Re-exported so existing importers (and tests) keep their entry point.
export { toOpenAiTool } from "./openaiCompatible.js";

const OPENAI_API_URL = "https://api.openai.com/v1/chat/completions";
const OPENAI_MODELS_URL = "https://api.openai.com/v1/models";

// Mirror the Anthropic provider's deadlines: generation can legitimately take a while, listing
// models cannot.
const MESSAGE_TIMEOUT_MS = 120_000;
const MODELS_TIMEOUT_MS = 15_000;

// Upper bound on tokens per completion. Unlike Anthropic's `max_tokens` (visible output only),
// OpenAI's `max_completion_tokens` also has to cover the hidden reasoning tokens the o-series
// spends before answering — a 4k cap can be entirely consumed by reasoning, leaving no output and
// a `length` finish. This is a ceiling, not a reservation (billing is per token produced), so a
// generous value is safe for non-reasoning models like gpt-4.1 too.
const MAX_COMPLETION_TOKENS = 32_768;

/**
 * OpenAI Chat Completions provider. A thin configuration of the shared
 * {@link OpenAiCompatibleProvider}: it pins the hosted OpenAI URLs, sends the user's key directly
 * from the browser (`Authorization: Bearer`, so the app stays server-free), and parses the OpenAI
 * model catalog. All request/response handling lives in the base.
 */
export class OpenAiBrowserProvider extends OpenAiCompatibleProvider {
  constructor(
    apiKey: string,
    model: string = OPENAI_DEFAULT_MODEL,
    target: TargetId = DEFAULT_TARGET,
  ) {
    super(
      {
        errorLabel: "OpenAI",
        chatUrl: OPENAI_API_URL,
        modelsUrl: OPENAI_MODELS_URL,
        model,
        maxCompletionTokens: MAX_COMPLETION_TOKENS,
        messageTimeoutMs: MESSAGE_TIMEOUT_MS,
        modelsTimeoutMs: MODELS_TIMEOUT_MS,
        authHeaders: () => ({ authorization: `Bearer ${apiKey}` }),
        parseModels: parseOpenAiModels,
      },
      target,
    );
  }
}
