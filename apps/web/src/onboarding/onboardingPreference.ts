import { useEffect, useState } from "react";

/**
 * Whether the first-run tour has been seen, and how far the user got. Device-local, persisted to
 * localStorage like the theme, rerank, and auto-draft preferences — the open core has no account to
 * hang it off, and a tour is per-browser anyway.
 *
 * Two values, written together:
 *   `grafture:onboarding`           — "done" once skipped or completed. Gates the auto-open.
 *   `grafture:onboarding-last-step` — the step *index* reached when skipped, so Replay resumes there.
 *
 * Completion clears the step: finishing the tour means the next replay starts from the top.
 */

const DONE_KEY = "grafture:onboarding";
const STEP_KEY = "grafture:onboarding-last-step";
const REPLAY_EVENT = "grafture:onboarding-replay";

export function readOnboardingCompleted(): boolean {
  try {
    return window.localStorage.getItem(DONE_KEY) === "done";
  } catch {
    // Private mode or a blocked origin: treat as not-yet-seen. Showing the tour once per session
    // is a better failure than never showing it at all.
    return false;
  }
}

/** The 0-based step index to resume on, clamped by the caller against the current step count. */
export function readOnboardingLastIndex(): number {
  try {
    const raw = window.localStorage.getItem(STEP_KEY);
    const parsed = raw === null ? Number.NaN : Number.parseInt(raw, 10);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : 0;
  } catch {
    return 0;
  }
}

/**
 * Mark the tour done. `lastIndex` is the step index the user was on when they skipped; omit it (or
 * pass 0) when they reached the end, which is what makes a later replay start from step one.
 */
export function markOnboardingSeen(lastIndex = 0): void {
  try {
    window.localStorage.setItem(DONE_KEY, "done");
    if (lastIndex > 0) {
      window.localStorage.setItem(STEP_KEY, String(lastIndex));
    } else {
      window.localStorage.removeItem(STEP_KEY);
    }
  } catch {
    // Ignore storage failures — the tour still closes for this session.
  }
}

/**
 * Replay from the beginning. Clears both keys and announces it, so a tour mounted right now reopens
 * without waiting for a remount — Settings unmounts the editor, but the Copilot's own help entry
 * (or anything else we add later) does not.
 */
export function resetOnboarding(): void {
  try {
    window.localStorage.removeItem(DONE_KEY);
    window.localStorage.removeItem(STEP_KEY);
  } catch {
    // Ignore — the event below still reopens the tour for this session.
  }
  window.dispatchEvent(new CustomEvent(REPLAY_EVENT));
}

/**
 * A counter that increments every time {@link resetOnboarding} runs, in this tab or another. The
 * overlay reopens on a change rather than on a boolean, so two replays in a row both land.
 */
export function useOnboardingReplays(): number {
  const [replays, setReplays] = useState(0);

  useEffect(() => {
    const onReplay = () => setReplays((value) => value + 1);
    const onStorage = (event: StorageEvent) => {
      // Another tab cleared the flag. `key === null` is a whole-storage clear, which also counts.
      if (event.key === null || event.key === DONE_KEY) {
        if (!readOnboardingCompleted()) {
          setReplays((value) => value + 1);
        }
      }
    };
    window.addEventListener(REPLAY_EVENT, onReplay);
    window.addEventListener("storage", onStorage);
    return () => {
      window.removeEventListener(REPLAY_EVENT, onReplay);
      window.removeEventListener("storage", onStorage);
    };
  }, []);

  return replays;
}
