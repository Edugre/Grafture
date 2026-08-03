import { useEffect } from "react";

import { useSchemaStore } from "../store/index.js";

export type HistoryShortcut = "undo" | "redo";

/** The shape of a keydown this matcher reads — a subset, so it can be tested without a DOM. */
export type ShortcutEvent = {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
};

/**
 * ⌘Z / ⌘⇧Z, with the Ctrl spellings (including Windows' Ctrl+Y) accepted on every platform rather
 * than switched on a sniffed OS: an external keyboard, a remote session, or a Linux user in a
 * Chromebook shell all produce the "wrong" modifier for the platform the page thinks it is on, and
 * neither combination means anything else here.
 */
export function matchHistoryShortcut(event: ShortcutEvent): HistoryShortcut | null {
  if (event.altKey || !(event.metaKey || event.ctrlKey)) {
    return null;
  }

  const key = event.key.toLowerCase();
  if (key === "z") {
    return event.shiftKey ? "redo" : "undo";
  }
  if (key === "y" && event.ctrlKey && !event.shiftKey) {
    return "redo";
  }
  return null;
}

/**
 * True for elements that own their own undo stack. Text editing has had ⌘Z since long before this
 * app existed, and hijacking it mid-rename to walk back a *schema* edit destroys work the user is
 * still typing — so a field being edited always wins.
 */
export function isTextEntry(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) {
    return false;
  }
  if (target.isContentEditable) {
    return true;
  }
  const tag = target.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT";
}

/**
 * Bind ⌘Z / ⌘⇧Z to the store's undo/redo for as long as the editor is mounted. Document-level, not
 * scoped to the canvas: the shortcut has to work while the user is in the sources panel or the
 * copilot, which is exactly where an accidental edit gets noticed.
 */
export function useHistoryShortcuts(): void {
  const undo = useSchemaStore((state) => state.undo);
  const redo = useSchemaStore((state) => state.redo);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (isTextEntry(event.target)) {
        return;
      }

      const shortcut = matchHistoryShortcut(event);
      if (!shortcut) {
        return;
      }

      // Claim it from the browser's own page-level undo before acting.
      event.preventDefault();
      if (shortcut === "undo") {
        undo();
      } else {
        redo();
      }
    };

    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [undo, redo]);
}
