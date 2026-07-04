import { useCallback, useEffect, useState } from "react";

import { PROVIDERS, type ProviderId } from "./providers.js";

/**
 * The selected model for a given provider, used for all AI calls (Copilot, suggestion rerank,
 * auto-draft). A device-local preference persisted to localStorage, scoped per provider so each
 * provider remembers its own model. Defaults to the provider's default model when unset. A custom
 * event keeps other readers in this tab in sync; the native `storage` event covers other tabs.
 */

const CHANGE_EVENT = "schema-studio:model-change";
/** The pre-multi-provider unscoped key — read once as a fallback so a saved Claude model survives. */
const LEGACY_KEY = "schema-studio:model";

function storageKey(provider: ProviderId): string {
  return `schema-studio:model:${provider}`;
}

export function readModelPreference(provider: ProviderId): string {
  try {
    const scoped = window.localStorage.getItem(storageKey(provider));
    if (scoped) {
      return scoped;
    }
    // The old unscoped key was Anthropic-only; honor it so existing users keep their choice.
    if (provider === "anthropic") {
      const legacy = window.localStorage.getItem(LEGACY_KEY);
      if (legacy) {
        return legacy;
      }
    }
    // Empty when the provider has no default (local) — it's unusable until a model is picked.
    return PROVIDERS[provider].defaultModel ?? "";
  } catch {
    return PROVIDERS[provider].defaultModel ?? "";
  }
}

function writeModelPreference(provider: ProviderId, model: string): void {
  try {
    window.localStorage.setItem(storageKey(provider), model);
  } catch {
    // Ignore storage failures (private mode, quota) — the choice still applies in-session.
  }
  window.dispatchEvent(new CustomEvent(CHANGE_EVENT, { detail: { provider, model } }));
}

/**
 * Imperatively set a specific provider's model, outside the active-provider hook. Used by the
 * unified model dropdown, which can select a model belonging to a provider other than the active
 * one — it sets that provider's model here, then flips the active provider to match.
 */
export function setModelPreference(provider: ProviderId, model: string): void {
  writeModelPreference(provider, model);
}

export function useModelPreference(provider: ProviderId): {
  model: string;
  setModel: (model: string) => void;
} {
  const [model, setModelState] = useState<string>(() => readModelPreference(provider));

  useEffect(() => {
    // Re-read on mount and whenever the active provider changes.
    setModelState(readModelPreference(provider));
    const onChange = () => setModelState(readModelPreference(provider));
    window.addEventListener(CHANGE_EVENT, onChange);
    window.addEventListener("storage", onChange);
    return () => {
      window.removeEventListener(CHANGE_EVENT, onChange);
      window.removeEventListener("storage", onChange);
    };
  }, [provider]);

  const setModel = useCallback(
    (next: string) => {
      setModelState(next);
      writeModelPreference(provider, next);
    },
    [provider],
  );

  return { model, setModel };
}
