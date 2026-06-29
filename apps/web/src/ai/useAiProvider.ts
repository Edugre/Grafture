import type { AiProvider } from "@schema-studio/core";
import { useMemo } from "react";

import { useApiKeyContext } from "../copilot/ApiKeyContext.js";
import { AnthropicBrowserProvider } from "./AnthropicBrowserProvider.js";

/**
 * The live AI provider built from the current BYO key, or null when no key is set. Shared by the
 * copilot pane and the suggestion reranker so both read the same in-memory key and rebuild the
 * provider identically when it changes.
 */
export function useAiProvider(): AiProvider | null {
  const { apiKey } = useApiKeyContext();
  return useMemo(() => {
    const trimmed = apiKey.trim();
    return trimmed ? new AnthropicBrowserProvider(trimmed) : null;
  }, [apiKey]);
}
