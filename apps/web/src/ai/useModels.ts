import type { ModelInfo } from "@schema-studio/core";
import { DEFAULT_TARGET } from "@schema-studio/core";
import { useEffect, useState } from "react";

import { useApiKeyContext } from "../copilot/ApiKeyContext.js";
import { mergeModels } from "./models.js";
import { useProviderPreference } from "./providerPreference.js";
import { PROVIDERS, PROVIDER_IDS, effectiveCredential, type ProviderId } from "./providers.js";

/** A selectable model tagged with the provider it belongs to, for the unified picker. */
export type ProviderModel = ModelInfo & { provider: ProviderId };

/** The union of every provider's static catalog, tagged by provider. Never empty. */
function staticProviderModels(): ProviderModel[] {
  return PROVIDER_IDS.flatMap((id) =>
    PROVIDERS[id].catalog.map((model) => ({ ...model, provider: id })),
  );
}

/**
 * The union of selectable models across ALL providers, tagged by provider — the source for the
 * unified model dropdown and the chat model picker. Seeds from every provider's static catalog,
 * then fetches the live list for each provider the user has opted into and merges it in. Per-provider
 * fetch failures silently keep that provider's static catalog. The request is keyed on a serialized
 * snapshot of the keys plus the active provider, so it re-runs only when a key is added/removed or
 * the active provider changes — not on unrelated preference changes. (The target stack is irrelevant
 * here: `listModels` ignores it, so the provider is built with `DEFAULT_TARGET` purely to satisfy
 * the factory.)
 */
export function useAllModels(): { models: ProviderModel[]; loading: boolean } {
  const { keyFor } = useApiKeyContext();
  const { provider: activeProvider } = useProviderPreference();

  // A stable primitive dep: refetch on any key change or active-provider switch, without a
  // new-array identity loop.
  const payload = JSON.stringify({
    active: activeProvider,
    keys: PROVIDER_IDS.map((id) => ({ id, key: keyFor(id).apiKey.trim() })),
  });

  const [models, setModels] = useState<ProviderModel[]>(staticProviderModels);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    const { active, keys } = JSON.parse(payload) as {
      active: ProviderId;
      keys: Array<{ id: ProviderId; key: string }>;
    };

    const tagged = (id: ProviderId, list: ModelInfo[]): ProviderModel[] =>
      list.map((model) => ({ ...model, provider: id }));

    // Fetch a provider's live models only when the user has opted into it: a stored credential
    // (key or custom endpoint), or it's the active provider. Local's always-on `defaultCredential`
    // must NOT by itself trigger a fetch — otherwise every user (even keyless) would probe the
    // local endpoint (e.g. http://localhost:11434) on every mount.
    const shouldFetch = (id: ProviderId, key: string) =>
      (key.length > 0 || id === active) && effectiveCredential(id, key).length > 0;

    if (keys.every((entry) => !shouldFetch(entry.id, entry.key))) {
      setModels(staticProviderModels());
      setLoading(false);
      return;
    }

    let cancelled = false;
    setLoading(true);
    void Promise.all(
      keys.map(async ({ id, key }): Promise<ProviderModel[]> => {
        const fallback = tagged(id, PROVIDERS[id].catalog);
        if (!shouldFetch(id, key)) {
          return fallback;
        }
        const provider = PROVIDERS[id].create(
          effectiveCredential(id, key),
          PROVIDERS[id].defaultModel ?? "",
          DEFAULT_TARGET,
        );
        if (!provider.listModels) {
          return fallback;
        }
        try {
          const fetched = await provider.listModels();
          return tagged(id, mergeModels(fetched, PROVIDERS[id].catalog));
        } catch {
          // Keep the static catalog for this provider on any failure.
          return fallback;
        }
      }),
    )
      .then((lists) => {
        if (!cancelled) {
          setModels(lists.flat());
        }
      })
      .finally(() => {
        if (!cancelled) {
          setLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [payload]);

  return { models, loading };
}
