import type { ModelInfo } from "@schema-studio/core";
import { DEFAULT_TARGET } from "@schema-studio/core";
import { useEffect, useState } from "react";

import { useApiKeyContext } from "../copilot/ApiKeyContext.js";
import { mergeModels } from "./models.js";
import { PROVIDERS, PROVIDER_IDS, type ProviderId } from "./providers.js";

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
 * then fetches the live list for each provider that has a key and merges it in. Per-provider fetch
 * failures silently keep that provider's static catalog. The request is keyed on a serialized
 * snapshot of the keys, so it re-runs only when a key is added/removed — not on unrelated
 * preference changes. (The target stack is irrelevant here: `listModels` ignores it, so the
 * provider is built with `DEFAULT_TARGET` purely to satisfy the factory.)
 */
export function useAllModels(): { models: ProviderModel[]; loading: boolean } {
  const { keyFor } = useApiKeyContext();

  // A stable primitive dep: refetch on any key change, without a new-array identity loop.
  const payload = JSON.stringify(PROVIDER_IDS.map((id) => ({ id, key: keyFor(id).apiKey.trim() })));

  const [models, setModels] = useState<ProviderModel[]>(staticProviderModels);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    const keys = JSON.parse(payload) as Array<{ id: ProviderId; key: string }>;

    const tagged = (id: ProviderId, list: ModelInfo[]): ProviderModel[] =>
      list.map((model) => ({ ...model, provider: id }));

    if (keys.every((entry) => !entry.key)) {
      setModels(staticProviderModels());
      setLoading(false);
      return;
    }

    let active = true;
    setLoading(true);
    void Promise.all(
      keys.map(async ({ id, key }): Promise<ProviderModel[]> => {
        const fallback = tagged(id, PROVIDERS[id].catalog);
        if (!key) {
          return fallback;
        }
        const provider = PROVIDERS[id].create(key, PROVIDERS[id].defaultModel, DEFAULT_TARGET);
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
        if (active) {
          setModels(lists.flat());
        }
      })
      .finally(() => {
        if (active) {
          setLoading(false);
        }
      });

    return () => {
      active = false;
    };
  }, [payload]);

  return { models, loading };
}
