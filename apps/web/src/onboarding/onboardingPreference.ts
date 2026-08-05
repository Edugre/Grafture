import { useEffect, useState } from "react";

/**
 * Whether the first-run tour has been seen. Device-local, persisted to localStorage like the theme,
 * rerank, and auto-draft preferences — the open core has no account to hang it off, and a tour is
 * per-browser anyway. One value: `grafture:onboarding` is "done" once the tour has been skipped or
 * completed, and that gates the auto-open.
 *
 * There was a second key here recording the step reached on a skip, meant for resume-on-replay. It
 * could never be read: marking the tour seen also sets the done flag, so the tour does not reopen,
 * and the only path that reopens it — `resetOnboarding` — clears the step and starts from the top,
 * which is what "Replay tutorial" should do anyway. Write-only state that documents behaviour the
 * code cannot produce is worse than no state, so it is gone. The key is removed on the next write
 * so browsers that already have one don't carry it forever.
 */

const DONE_KEY = "grafture:onboarding";
/** Only ever removed — see the note above. */
const LEGACY_STEP_KEY = "grafture:onboarding-last-step";
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

/** Mark the tour done, whether it was skipped or finished. */
export function markOnboardingSeen(): void {
  try {
    window.localStorage.setItem(DONE_KEY, "done");
    window.localStorage.removeItem(LEGACY_STEP_KEY);
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
    window.localStorage.removeItem(LEGACY_STEP_KEY);
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
