import { useCallback, useEffect, useRef, useState, type RefObject } from "react";

import { isTextEntry } from "../history/shortcuts.js";
import { useSchemaStore } from "../store/index.js";
import { XIcon } from "../ui/icons.js";
import "./OnboardingTour.css";
import {
  markOnboardingSeen,
  readOnboardingCompleted,
  readOnboardingLastIndex,
  useOnboardingReplays,
} from "./onboardingPreference.js";
import { type Rect, formatCounter, placeModal, sameRect, spotlightRect } from "./placement.js";
import { type ResolvedStep, type TourContext, type TourStage, resolveSteps } from "./steps.js";

/**
 * How long a step's anchor may stay missing before the tour moves on. This is now only a safety
 * net — `resolveSteps` drops the steps this project can't show *before* the tour opens, so in the
 * ordinary case every step in the sequence has an anchor waiting. What's left for the grace to
 * catch is the narrow gap the resolver approximates over (see `hasSuggestions` below) and anything
 * that disappears mid-tour. Long enough to cover a rail expanding and a tab swapping.
 */
const ANCHOR_GRACE_MS = 500;

/** The scrollable rail an anchor lives in, if any — the sources and copilot panes both use it. */
function scrollParent(element: HTMLElement): HTMLElement | null {
  return element.closest(".panel-body");
}

/**
 * Bring an anchor inside the shell without `scrollIntoView`, which scrolls every ancestor including
 * the page and would shift the shell itself out from under the measured coordinates. Only the one
 * rail moves, and only when the anchor is genuinely outside it.
 */
function ensureVisible(element: HTMLElement): void {
  const rail = scrollParent(element);
  if (!rail || rail.scrollHeight <= rail.clientHeight) {
    return;
  }
  const railRect = rail.getBoundingClientRect();
  const elementRect = element.getBoundingClientRect();
  const margin = 16;

  if (elementRect.top < railRect.top + margin) {
    rail.scrollTop -= railRect.top + margin - elementRect.top;
  } else if (elementRect.bottom > railRect.bottom - margin) {
    rail.scrollTop += elementRect.bottom - (railRect.bottom - margin);
  }
}

export function OnboardingTour({
  shellRef,
  onStage,
}: {
  /** The editor shell. Must be `position: relative` — every coordinate here is relative to it. */
  shellRef: RefObject<HTMLElement | null>;
  /**
   * Asks the editor to arrange itself for the current step, and — with `null` — to put back what it
   * had before the tour started. The tour never reaches into the panels itself.
   */
  onStage: (stage: TourStage | null) => void;
}) {
  const replays = useOnboardingReplays();

  const hasSources = useSchemaStore((state) => state.sources.length > 0);
  const hasRelationships = useSchemaStore((state) => state.schema.relationships.length > 0);
  // `hasSources` stands in for "the detectors found something". The exact answer is `useSuggestions`,
  // but that runs `detectJoinKeys` in a memo — ~3.7s on real files, and per CLAUDE.md that work
  // never goes on an interactive path. The approximation is only ever wrong one way (sources but no
  // findings), and the grace-skip above still catches that, so the cost is one rare late skip rather
  // than a detector run every time the tour opens.
  const contextRef = useRef<TourContext>({
    hasSources,
    hasRelationships,
    hasSuggestions: hasSources,
  });
  contextRef.current = { hasSources, hasRelationships, hasSuggestions: hasSources };

  const [open, setOpen] = useState(() => !readOnboardingCompleted());
  // Resolved once, when the tour opens, and frozen for its duration — a sequence that restructured
  // because the user dropped a file mid-tour would renumber the card they are reading.
  const [steps, setSteps] = useState<ResolvedStep[]>(() => resolveSteps(contextRef.current));
  const [index, setIndex] = useState(() =>
    Math.max(0, Math.min(steps.length - 1, readOnboardingLastIndex())),
  );
  const [spot, setSpot] = useState<Rect | null>(null);
  const [shellSize, setShellSize] = useState({ width: 0, height: 0 });
  // True from the moment a step is entered until its anchor has been measured. The card stays
  // unmounted while it is set, so a step is never *displayed* against the wrong spotlight — the
  // failure the grace window used to create every time it skipped one.
  const [pending, setPending] = useState(true);

  const cardRef = useRef<HTMLDivElement>(null);
  // Which way the user was heading, so a missing anchor is skipped *past* rather than bounced off.
  const directionRef = useRef<1 | -1>(1);
  // The live index, for the measurement loop's close/advance decisions without re-arming the loop.
  const indexRef = useRef(index);
  indexRef.current = index;

  const lastIndex = steps.length - 1;
  const step = steps[index];

  const clampIndex = useCallback(
    (value: number) => Math.max(0, Math.min(steps.length - 1, value)),
    [steps.length],
  );

  const close = useCallback(
    (completed: boolean) => {
      markOnboardingSeen(completed ? 0 : indexRef.current);
      setOpen(false);
      setSpot(null);
      onStage(null);
    },
    [onStage],
  );

  const go = useCallback(
    (direction: 1 | -1) => {
      directionRef.current = direction;
      setIndex((current) => clampIndex(current + direction));
    },
    [clampIndex],
  );

  const next = useCallback(() => {
    if (indexRef.current >= lastIndex) {
      close(true);
      return;
    }
    go(1);
  }, [close, go, lastIndex]);

  const back = useCallback(() => go(-1), [go]);

  // Replay: reopen from the top whenever the preference is cleared, here or in another tab. The
  // sequence is re-resolved here — a user who replays after loading files should get the full tour.
  useEffect(() => {
    if (replays > 0) {
      directionRef.current = 1;
      setSteps(resolveSteps(contextRef.current));
      setIndex(0);
      setPending(true);
      setOpen(true);
    }
  }, [replays]);

  // Ask the editor to open whatever this step points at. Steps that declare no stage leave the
  // arrangement alone rather than collapsing it again — the canvas steps read fine either way, and
  // reflowing the shell twice per step is worse than a rail staying open one step longer.
  useEffect(() => {
    if (!open) {
      return;
    }
    onStage(step?.stage ?? {});
  }, [open, step, onStage]);

  // Give the shell back if the editor unmounts mid-tour (project switch, Settings).
  useEffect(() => () => onStage(null), [onStage]);

  /*
   * Measure on every frame while the tour is open. The alternatives — resize and scroll listeners,
   * a ResizeObserver on the shell, a ReactFlow viewport subscription — each cover one way the
   * target can move, and the canvas alone can move it by panning, zooming, auto-arranging, or
   * dragging the node the spotlight is on. A ring that lags any of those is a ring pointing at the
   * wrong control. Two `getBoundingClientRect` calls per frame for the length of a tour is the
   * cheaper mistake, and state is only written when the rect actually changed.
   */
  useEffect(() => {
    if (!open) {
      return;
    }

    let frame = 0;
    let missingSince: number | null = null;
    let scrolled = false;

    const tick = () => {
      const shell = shellRef.current;
      const current = steps[index];
      if (!shell || !current) {
        return;
      }

      // The shell's own size is measured, never read during render: on the tour's very first render
      // the ref is still null, and an untargeted step writes no other state to correct it with —
      // which is how step one ended up half off the left edge.
      const size = { width: shell.clientWidth, height: shell.clientHeight };
      setShellSize((previous) =>
        previous.width === size.width && previous.height === size.height ? previous : size,
      );

      if (!current.target) {
        missingSince = null;
        setSpot((previous) => (previous === null ? previous : null));
        setPending(false);
        return;
      }

      const element = shell.querySelector<HTMLElement>(`[data-tour="${current.target}"]`);
      // A zero-size box is an element that exists but isn't laid out (a collapsed rail's leftovers,
      // an edge label the canvas hasn't painted yet) — indistinguishable from absent, for us.
      const rect = element?.getBoundingClientRect();
      if (!element || !rect || rect.width === 0 || rect.height === 0) {
        scrolled = false;
        const now = performance.now();
        if (missingSince === null) {
          missingSince = now;
        } else if (now - missingSince > ANCHOR_GRACE_MS) {
          missingSince = null;
          const direction = directionRef.current;
          if (index + direction > steps.length - 1) {
            close(true);
          } else {
            go(direction);
          }
        }
        return;
      }

      missingSince = null;
      if (!scrolled) {
        // Once per step: nudge the owning rail so an anchor below the fold comes into view.
        scrolled = true;
        ensureVisible(element);
        return;
      }

      const shellRect = shell.getBoundingClientRect();
      const measured = spotlightRect(rect, shellRect);
      setSpot((previous) => (sameRect(previous, measured) ? previous : measured));
      setPending(false);
    };

    // First pass runs synchronously so a step whose anchor is already on screen never paints one
    // frame of full scrim before the ring appears.
    const loop = () => {
      tick();
      frame = requestAnimationFrame(loop);
    };
    loop();
    return () => cancelAnimationFrame(frame);
  }, [open, index, steps, shellRef, close, go]);

  // Entering a step puts the card back into "not yet placed" until the loop above confirms an
  // anchor. Without this the card would render immediately, against whatever spotlight the previous
  // step left behind.
  useEffect(() => {
    setPending(true);
  }, [index, steps]);

  // A re-resolve can leave the cursor past the end (replaying a shorter sequence).
  useEffect(() => {
    setIndex((current) => clampIndex(current));
  }, [clampIndex]);

  // → next, ← back, Esc skip. Document-level so the shortcut works wherever focus has wandered —
  // the tour is non-blocking, so that could be anywhere — and yielding to text entry the same way
  // the undo shortcut does, or Esc would close the tour instead of the field the user is in.
  useEffect(() => {
    if (!open) {
      return;
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (isTextEntry(event.target) || event.metaKey || event.ctrlKey || event.altKey) {
        return;
      }
      if (event.key === "ArrowRight") {
        event.preventDefault();
        next();
      } else if (event.key === "ArrowLeft") {
        event.preventDefault();
        back();
      } else if (event.key === "Escape") {
        event.preventDefault();
        close(false);
      }
    };
    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [open, next, back, close]);

  // Move focus to the card on every step change so the new copy is what a screen reader lands on
  // and Tab starts from Skip rather than from wherever the last click left off.
  useEffect(() => {
    if (open) {
      cardRef.current?.focus();
    }
  }, [open, index]);

  // Nothing to place until the shell has been measured (a card positioned against a zero-width
  // shell lands off the edge), and nothing to show until the current step's anchor has been found.
  // `pending` is what makes a skip invisible: the step that is about to be skipped never paints.
  if (!open || !step || shellSize.width === 0 || pending) {
    return null;
  }

  const modal = placeModal(spot, shellSize);
  const targeted = spot !== null;
  const counter = formatCounter(index, steps.length);
  const titleId = `tour-title-${index}`;

  return (
    <div className="tour">
      {/* One box, not two: the scrim is this element's outer box-shadow, so the hole and the dim
          are the same thing and can never drift apart mid-transition. */}
      <div
        className={`tour__spotlight${targeted ? " is-targeted" : ""}`}
        style={
          targeted
            ? { left: spot.left, top: spot.top, width: spot.width, height: spot.height }
            : { left: shellSize.width / 2, top: shellSize.height / 2, width: 0, height: 0 }
        }
        aria-hidden
      />

      <div
        className="tour__card"
        ref={cardRef}
        role="dialog"
        aria-modal={false}
        aria-labelledby={titleId}
        tabIndex={-1}
        // Placed with `transform`, not `left`/`top`: the card has no hole to punch, so there is no
        // reason for it to move on the layout properties the spotlight is stuck with.
        style={{
          transform: `translate3d(${modal.left}px, ${modal.top}px, 0)`,
          width: modal.width,
        }}
      >
        {/* Announces the step, not the card: the visible copy is already read on focus, and the
            counter is what tells a screen-reader user where they are in the sequence. */}
        <span className="sr-only" role="status">
          {`${counter} — ${step.title}`}
        </span>

        <div className="tour__eyebrow-row">
          <span className="tour__eyebrow">{step.eyebrow}</span>
          <button type="button" className="tour__skip" onClick={() => close(false)}>
            Skip tour
            <XIcon size={12} />
          </button>
        </div>

        <h2 className="tour__title" id={titleId}>
          {step.title}
        </h2>
        <p className="tour__body">{step.body}</p>
        {step.note ? <p className="tour__note">{step.note}</p> : null}

        {/* The fill is full-width and scaled, so the growth animates on `transform` rather than
            on `width`. `aria-hidden` because the counter beside it already says 02 / 10. */}
        <div className="tour__progress" aria-hidden>
          <div
            className="tour__progress-fill"
            style={{ transform: `scaleX(${(index + 1) / steps.length})` }}
          />
        </div>

        <div className="tour__footer">
          <span className="tour__counter">{counter}</span>
          <div className="tour__actions">
            {index > 0 ? (
              <button type="button" className="tour__btn" onClick={back}>
                Back
              </button>
            ) : null}
            <button type="button" className="tour__btn tour__btn--primary" onClick={next}>
              {step.nextLabel ?? "Next"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
