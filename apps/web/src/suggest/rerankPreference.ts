import { useCallback, useEffect, useState } from "react";

/**
 * The opt-in "AI-ranked suggestions" preference (default off). A device-local toggle, persisted to
 * localStorage exactly like the theme preference. Reading it costs a billable LLM call, so it stays
 * off until the user enables it in Settings. A custom event keeps any other mounted reader (the
 * Settings page and the suggestions hook) in sync within the same tab.
 */

const STORAGE_KEY = "schema-studio:rerank-suggestions";
const CHANGE_EVENT = "schema-studio:rerank-suggestions-change";

export function readRerankPreference(): boolean {
  try {
    return window.localStorage.getItem(STORAGE_KEY) === "on";
  } catch {
    return false;
  }
}

function writeRerankPreference(enabled: boolean): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, enabled ? "on" : "off");
  } catch {
    // Ignore storage failures (private mode, quota) — the preference still applies in-session.
  }
  window.dispatchEvent(new CustomEvent(CHANGE_EVENT, { detail: enabled }));
}

export function useRerankPreference(): {
  enabled: boolean;
  setEnabled: (enabled: boolean) => void;
} {
  const [enabled, setEnabledState] = useState<boolean>(() => readRerankPreference());

  // Stay in sync with writes from elsewhere in the tab (same-tab custom event) and from other tabs
  // (the native `storage` event, which doesn't fire in the originating tab).
  useEffect(() => {
    const onChange = () => setEnabledState(readRerankPreference());
    window.addEventListener(CHANGE_EVENT, onChange);
    window.addEventListener("storage", onChange);
    return () => {
      window.removeEventListener(CHANGE_EVENT, onChange);
      window.removeEventListener("storage", onChange);
    };
  }, []);

  const setEnabled = useCallback((next: boolean) => {
    setEnabledState(next);
    writeRerankPreference(next);
  }, []);

  return { enabled, setEnabled };
}
