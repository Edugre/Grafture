import { useCallback, useEffect, useRef, useState } from "react";

import { PROVIDER_IDS, type ProviderId } from "../ai/providers.js";
import { useProviderPreference } from "../ai/providerPreference.js";
import { IndexedDbKeyValueStore } from "../persistence/kv.js";
import { clearStoredApiKey, getStoredApiKey, setStoredApiKey } from "../persistence/secretStore.js";
import type { KeyValueStore } from "../persistence/types.js";

export type ProviderKeyState = { apiKey: string; remember: boolean };

export type UseApiKey = {
  /** The active provider's key (convenience for the copilot + settings). */
  apiKey: string;
  /** Whether the active provider's key is persisted. */
  remember: boolean;
  /** Read a specific provider's in-memory key state (for the BYO-key page's provider segment). */
  keyFor: (provider: ProviderId) => ProviderKeyState;
  /** Update a provider's in-memory key. If its "remember" is on, the new value is persisted too. */
  setApiKey: (provider: ProviderId, key: string) => void;
  /** Toggle a provider's persistence. On writes the current key; off erases the stored copy. */
  setRemember: (provider: ProviderId, remember: boolean) => void;
};

const EMPTY: ProviderKeyState = { apiKey: "", remember: false };

function emptyKeyMap(): Record<ProviderId, ProviderKeyState> {
  return Object.fromEntries(PROVIDER_IDS.map((id) => [id, EMPTY])) as Record<
    ProviderId,
    ProviderKeyState
  >;
}

/**
 * Owns the BYO API keys — one per provider. Each key lives in memory by default and is only
 * written to local storage when the user opts into "remember" for that provider. Switching the
 * active provider (via {@link useProviderPreference}) just changes which key the copilot uses; no
 * key is erased. The key/value backend is injectable for tests.
 */
export function useApiKey(
  createKv: () => KeyValueStore = () => new IndexedDbKeyValueStore(),
): UseApiKey {
  const kvRef = useRef<KeyValueStore | null>(null);
  if (kvRef.current === null) {
    kvRef.current = createKv();
  }
  const kv = kvRef.current;

  const { provider: activeProvider } = useProviderPreference();
  const [keys, setKeys] = useState<Record<ProviderId, ProviderKeyState>>(emptyKeyMap);

  // Hydrate every provider's remembered key on mount.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const entries = await Promise.all(
        PROVIDER_IDS.map(async (id) => [id, await getStoredApiKey(kv, id)] as const),
      );
      if (cancelled) {
        return;
      }
      setKeys((prev) => {
        const next = { ...prev };
        for (const [id, stored] of entries) {
          if (stored) {
            next[id] = { apiKey: stored, remember: true };
          }
        }
        return next;
      });
    })();
    return () => {
      cancelled = true;
    };
  }, [kv]);

  // The sibling field is read from the setKeys updater's `prev`, not a closed-over `keys`, so the
  // persistence decision always sees the latest state — including an earlier setRemember/setApiKey
  // in the same batch — and the callbacks keep a stable identity (deps: [kv]) instead of being
  // re-created on every keystroke. The storage writes are idempotent, so running inside the updater
  // (and any StrictMode double-invoke) is safe.
  const setApiKey = useCallback(
    (provider: ProviderId, key: string) => {
      setKeys((prev) => {
        const { remember } = prev[provider];
        if (remember) {
          if (key.trim()) {
            void setStoredApiKey(kv, provider, key);
          } else {
            void clearStoredApiKey(kv, provider);
          }
        }
        return { ...prev, [provider]: { apiKey: key, remember } };
      });
    },
    [kv],
  );

  const setRemember = useCallback(
    (provider: ProviderId, next: boolean) => {
      setKeys((prev) => {
        const { apiKey } = prev[provider];
        if (next) {
          if (apiKey.trim()) {
            void setStoredApiKey(kv, provider, apiKey);
          }
        } else {
          void clearStoredApiKey(kv, provider);
        }
        return { ...prev, [provider]: { apiKey, remember: next } };
      });
    },
    [kv],
  );

  const keyFor = useCallback((provider: ProviderId) => keys[provider], [keys]);

  const active = keys[activeProvider];
  return {
    apiKey: active.apiKey,
    remember: active.remember,
    keyFor,
    setApiKey,
    setRemember,
  };
}
