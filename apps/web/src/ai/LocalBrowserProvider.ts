import { DEFAULT_TARGET, type TargetId } from "@schema-studio/core";

import { OpenAiCompatibleProvider } from "./openaiCompatible.js";
import { LOCAL_DEFAULT_ENDPOINT, parseLocalModels } from "./localModels.js";

// Local generation is far slower than a hosted API (CPU inference on a laptop can take minutes), so
// the generation deadline is generous; listing models is a cheap call and stays short.
const MESSAGE_TIMEOUT_MS = 300_000;
const MODELS_TIMEOUT_MS = 10_000;

// Local runtimes report finish reasons the same way the hosted API does, so the same generous cap
// applies; it is a ceiling, not a reservation.
const MAX_COMPLETION_TOKENS = 32_768;

/** Trim a trailing slash so `${base}/models` never doubles up. */
function normalizeEndpoint(endpoint: string): string {
  const trimmed = endpoint.trim();
  return trimmed.endsWith("/") ? trimmed.slice(0, -1) : trimmed;
}

/**
 * A browser `fetch` to a local server fails with a bare `TypeError: Failed to fetch` for two very
 * different reasons that we can't tell apart from JS: the server isn't running, or it's running but
 * refusing this origin (CORS). Both are the user's to fix locally, so we surface the actionable
 * version instead of the raw error. This guidance is the single most common support answer for
 * browser-based local-LLM setups.
 */
function describeLocalTransportError(error: unknown, endpoint: string): string | undefined {
  // A timeout aborts with a DOMException, not a transport TypeError — leave that to bubble as-is.
  if (error instanceof DOMException) {
    return undefined;
  }
  // Read the live origin when in a browser; fall back to the dev origin for the example string.
  const origin = globalThis.location?.origin ?? "http://localhost:5173";
  return (
    `Couldn't reach a local model server at ${endpoint}. ` +
    `Make sure your runtime is running, and that it allows requests from this page. ` +
    `For Ollama, start it with OLLAMA_ORIGINS set to this app's origin ` +
    `(e.g. OLLAMA_ORIGINS="${origin}" ollama serve).`
  );
}

/**
 * Local-runtime provider. A configuration of the shared {@link OpenAiCompatibleProvider} pointed at
 * a user-supplied base URL (Ollama, LM Studio, llama.cpp, vLLM — anything OpenAI-compatible)
 * instead of the hosted API. Keyless by default (`Authorization` is omitted), with a longer
 * generation deadline and transport errors rewritten into setup guidance. Everything runs on the
 * user's machine, so nothing here touches the network beyond `endpoint`.
 */
export class LocalBrowserProvider extends OpenAiCompatibleProvider {
  constructor(
    endpoint: string = LOCAL_DEFAULT_ENDPOINT,
    model = "",
    target: TargetId = DEFAULT_TARGET,
  ) {
    const base = normalizeEndpoint(endpoint || LOCAL_DEFAULT_ENDPOINT);
    super(
      {
        errorLabel: "Local",
        chatUrl: `${base}/chat/completions`,
        modelsUrl: `${base}/models`,
        model,
        maxCompletionTokens: MAX_COMPLETION_TOKENS,
        messageTimeoutMs: MESSAGE_TIMEOUT_MS,
        modelsTimeoutMs: MODELS_TIMEOUT_MS,
        // Keyless: a local server needs no auth header.
        authHeaders: () => ({}),
        parseModels: parseLocalModels,
        describeTransportError: (error) => describeLocalTransportError(error, base),
        // Many local models lack function calling; fall back to prompt-based JSON when the tool
        // loop can't run. Hosted providers keep the strict tool loop.
        allowJsonFallback: true,
      },
      target,
    );
  }
}
