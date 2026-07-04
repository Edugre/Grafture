import { useCallback, useEffect, useState } from "react";

import { toProviderId, type ProviderId } from "./providers.js";

/**
 * The active AI provider (Anthropic or OpenAI) for all AI calls. A device-local preference
 * persisted to localStorage like the theme/model toggles. Defaults to Anthropic when unset. A
 * custom event keeps other readers in this tab in sync; the native `storage` event covers other
 * tabs.
 */

const STORAGE_KEY = "schema-studio:provider";
const CHANGE_EVENT = "schema-studio:provider-change";

export function readProviderPreference(): ProviderId {
  try {
    return toProviderId(window.localStorage.getItem(STORAGE_KEY));
  } catch {
    return "anthropic";
  }
}

function writeProviderPreference(provider: ProviderId): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, provider);
  } catch {
    // Ignore storage failures (private mode, quota) — the choice still applies in-session.
  }
  window.dispatchEvent(new CustomEvent(CHANGE_EVENT, { detail: provider }));
}

export function useProviderPreference(): {
  provider: ProviderId;
  setProvider: (provider: ProviderId) => void;
} {
  const [provider, setProviderState] = useState<ProviderId>(() => readProviderPreference());

  useEffect(() => {
    const onChange = () => setProviderState(readProviderPreference());
    window.addEventListener(CHANGE_EVENT, onChange);
    window.addEventListener("storage", onChange);
    return () => {
      window.removeEventListener(CHANGE_EVENT, onChange);
      window.removeEventListener("storage", onChange);
    };
  }, []);

  const setProvider = useCallback((next: ProviderId) => {
    setProviderState(next);
    writeProviderPreference(next);
  }, []);

  return { provider, setProvider };
}
