import type { AiProvider } from "@schema-studio/core";
import { useMemo } from "react";

import { useApiKeyContext } from "../copilot/ApiKeyContext.js";
import { useModelPreference } from "./modelPreference.js";
import { useProviderPreference } from "./providerPreference.js";
import { PROVIDERS } from "./providers.js";
import { useTargetPreference } from "./targetPreference.js";

/**
 * The live AI provider built from the active provider, its BYO key, the selected model, and the
 * target stack — or null when no key is set for the active provider. Shared by the copilot pane
 * and the suggestion reranker so both read the same in-memory key and rebuild the provider
 * identically when the provider, key, model, or target changes.
 */
export function useAiProvider(): AiProvider | null {
  const { provider } = useProviderPreference();
  const { apiKey } = useApiKeyContext();
  const { model } = useModelPreference(provider);
  const { target } = useTargetPreference();
  return useMemo(() => {
    const trimmed = apiKey.trim();
    return trimmed ? PROVIDERS[provider].create(trimmed, model, target) : null;
  }, [provider, apiKey, model, target]);
}
