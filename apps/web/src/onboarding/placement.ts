/**
 * Geometry for the tour overlay, kept pure so it can be tested without a DOM. Everything here is
 * in **shell-relative** coordinates — the caller subtracts the shell's own client rect first.
 */

export type Rect = { left: number; top: number; width: number; height: number };

/**
 * Modal width from the handoff. The copy was written to this measure, so it is a ceiling rather
 * than a target — see {@link modalWidth}.
 */
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

/** Slack a side needs beyond the card's own width before the card is placed there. */
const SIDE_SLACK = 48;

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
 * Keep the card's bottom edge inside the shell. Applies to targeted and untargeted steps alike:
 * `.tour` is `overflow: hidden` and the card is the only thing on the overlay that takes pointer
 * events, so a footer past the bottom edge is a Skip and a Next the user cannot reach at all.
 */
function clampTop(top: number, shellHeight: number): number {
  if (top + MODAL_MAX_HEIGHT > shellHeight - MODAL_GAP) {
    return Math.max(MODAL_GAP, shellHeight - MODAL_GAP - MODAL_MAX_HEIGHT);
  }
  return top;
}

/**
 * The card's actual width: {@link MODAL_WIDTH}, or as much of it as fits between the shell's
 * margins. A shell narrower than 444px is not a shape this editor is used at, but a card that keeps
 * its 396px there overruns the shell — and because the overlay clips, what gets cut is the right
 * edge, which is exactly where the Next button lives. Losing the primary action to a viewport is
 * worse than a narrower measure.
 */
export function modalWidth(shellWidth: number): number {
  return Math.min(MODAL_WIDTH, Math.max(0, shellWidth - MODAL_GAP * 2));
}

/**
 * Where the card goes, and how wide. Right of the spotlight when there's room, else left, else
 * centered under the spotlight's horizontal midpoint. Vertically it starts level with the spotlight
 * and is lifted only if it would otherwise overrun the shell's bottom.
 */
export function placeModal(
  spot: Rect | null,
  shell: { width: number; height: number },
): { left: number; top: number; width: number } {
  const width = modalWidth(shell.width);

  if (!spot) {
    return { left: (shell.width - width) / 2, top: clampTop(UNTARGETED_TOP, shell.height), width };
  }

  const sideRoom = width + SIDE_SLACK;
  const rightRoom = shell.width - (spot.left + spot.width);
  let left: number;
  if (rightRoom >= sideRoom) {
    left = spot.left + spot.width + MODAL_GAP;
  } else if (spot.left >= sideRoom) {
    left = spot.left - MODAL_GAP - width;
  } else {
    left = clamp(
      spot.left + spot.width / 2 - width / 2,
      MODAL_GAP,
      shell.width - width - MODAL_GAP,
    );
  }

  return { left, top: clampTop(spot.top, shell.height), width };
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
