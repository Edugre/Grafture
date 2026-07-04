import type { AiProvider } from "@schema-studio/core";
import { useMemo } from "react";

import { useApiKeyContext } from "../copilot/ApiKeyContext.js";
import { useModelPreference } from "./modelPreference.js";
import { useProviderPreference } from "./providerPreference.js";
import { PROVIDERS, effectiveCredential } from "./providers.js";
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
    // A provider with a `defaultCredential` (local) is usable before the user sets anything; key
    // providers stay null until a key is entered.
    const credential = effectiveCredential(provider, apiKey);
    // A concrete model is required too: local has no default model, so it stays null until the user
    // picks one from the picker — never build a provider that would POST an empty model id.
    const trimmedModel = model.trim();
    return credential && trimmedModel
      ? PROVIDERS[provider].create(credential, trimmedModel, target)
      : null;
  }, [provider, apiKey, model, target]);
}
