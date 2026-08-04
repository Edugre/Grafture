/**
 * Geometry for the tour overlay, kept pure so it can be tested without a DOM. Everything here is
 * in **shell-relative** coordinates — the caller subtracts the shell's own client rect first.
 */

export type Rect = { left: number; top: number; width: number; height: number };

/** Modal width from the handoff. Fixed, not fluid: the copy was written to this measure. */
export const MODAL_WIDTH = 396;

/**
 * Assumed modal height for the bottom-edge check. The card's real height varies with the body copy
 * and whether the step has a note, but the placement only needs to know whether it would run off
 * the bottom — an over-estimate keeps the whole card on screen and never clips the footer buttons.
 */
export const MODAL_MAX_HEIGHT = 340;

/** How far the spotlight ring stands off the element it rings. */
export const SPOTLIGHT_PAD = 8;

/** Gap between the spotlight and the card, and the minimum margin to the shell's edges. */
const MODAL_GAP = 24;

/** A side only wins if it can hold the card *and* keep it off the shell edge. */
const SIDE_ROOM = MODAL_WIDTH + 48;

/** Where an untargeted step's card sits: upper third, not vertically centered. */
const UNTARGETED_TOP = 300;

function clamp(value: number, min: number, max: number): number {
  // `min` wins on a shell narrower than the card — better a card flush to the left edge than one
  // pushed off the right.
  return Math.max(min, Math.min(max, value));
}

/**
 * The spotlight box: the target's rect made shell-relative and inflated by {@link SPOTLIGHT_PAD} on
 * all sides. Not clamped to the shell — a target scrolled half out of a rail should have its ring
 * clipped by the shell rather than silently resized to something that isn't the element.
 */
export function spotlightRect(target: Rect, shell: Rect): Rect {
  return {
    left: target.left - shell.left - SPOTLIGHT_PAD,
    top: target.top - shell.top - SPOTLIGHT_PAD,
    width: target.width + SPOTLIGHT_PAD * 2,
    height: target.height + SPOTLIGHT_PAD * 2,
  };
}

/**
 * Where the card goes. Right of the spotlight when there's room, else left, else centered under the
 * spotlight's horizontal midpoint. Vertically it starts level with the spotlight and is lifted only
 * if it would otherwise overrun the shell's bottom.
 */
export function placeModal(
  spot: Rect | null,
  shell: { width: number; height: number },
): { left: number; top: number } {
  if (!spot) {
    return { left: (shell.width - MODAL_WIDTH) / 2, top: UNTARGETED_TOP };
  }

  const rightRoom = shell.width - (spot.left + spot.width);
  let left: number;
  if (rightRoom >= SIDE_ROOM) {
    left = spot.left + spot.width + MODAL_GAP;
  } else if (spot.left >= SIDE_ROOM) {
    left = spot.left - MODAL_GAP - MODAL_WIDTH;
  } else {
    left = clamp(
      spot.left + spot.width / 2 - MODAL_WIDTH / 2,
      MODAL_GAP,
      shell.width - MODAL_WIDTH - MODAL_GAP,
    );
  }

  let top = spot.top;
  if (top + MODAL_MAX_HEIGHT > shell.height - MODAL_GAP) {
    top = Math.max(MODAL_GAP, shell.height - MODAL_GAP - MODAL_MAX_HEIGHT);
  }

  return { left, top };
}

/** `01 / 10` — both sides zero-padded to two, so the counter never changes width mid-tour. */
export function formatCounter(index: number, total: number): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(index + 1)} / ${pad(total)}`;
}

/** Two rects are the same to within half a device pixel — the threshold for a repaint being worth it. */
export function sameRect(a: Rect | null, b: Rect | null): boolean {
  if (a === null || b === null) {
    return a === b;
  }
  return (
    Math.abs(a.left - b.left) < 0.5 &&
    Math.abs(a.top - b.top) < 0.5 &&
    Math.abs(a.width - b.width) < 0.5 &&
    Math.abs(a.height - b.height) < 0.5
  );
}
