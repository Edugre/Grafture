import { useCallback, useEffect, useState } from "react";

/**
 * The opt-in "draft an initial schema with AI" preference (default off). A device-local toggle,
 * persisted to localStorage like the theme and rerank preferences. When on, deriving a project
 * from the New Project modal sends its files + description to the Copilot to draft a schema (shown
 * as a reviewable ghost proposal). It fires a billable LLM call, so it stays off until enabled in
 * Settings. A custom event keeps any other mounted reader in sync within the same tab.
 */

const STORAGE_KEY = "schema-studio:auto-draft";
const CHANGE_EVENT = "schema-studio:auto-draft-change";

export function readAutoDraftPreference(): boolean {
  try {
    return window.localStorage.getItem(STORAGE_KEY) === "on";
  } catch {
    return false;
  }
}

function writeAutoDraftPreference(enabled: boolean): void {
  try {
    window.localStorage.setItem(STORAGE_KEY, enabled ? "on" : "off");
  } catch {
    // Ignore storage failures (private mode, quota) — the preference still applies in-session.
  }
  window.dispatchEvent(new CustomEvent(CHANGE_EVENT, { detail: enabled }));
}

export function useAutoDraftPreference(): {
  enabled: boolean;
  setEnabled: (enabled: boolean) => void;
} {
  const [enabled, setEnabledState] = useState<boolean>(() => readAutoDraftPreference());

  // Stay in sync with writes from elsewhere in the tab (same-tab custom event) and from other tabs
  // (the native `storage` event, which doesn't fire in the originating tab).
  useEffect(() => {
    const onChange = () => setEnabledState(readAutoDraftPreference());
    window.addEventListener(CHANGE_EVENT, onChange);
    window.addEventListener("storage", onChange);
    return () => {
      window.removeEventListener(CHANGE_EVENT, onChange);
      window.removeEventListener("storage", onChange);
    };
  }, []);

  const setEnabled = useCallback((next: boolean) => {
    setEnabledState(next);
    writeAutoDraftPreference(next);
  }, []);

  return { enabled, setEnabled };
}
