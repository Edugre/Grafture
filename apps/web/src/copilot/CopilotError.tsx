import { useEffect, useRef, useState } from "react";

import type { Attempt, RetryProgress } from "../ai/retry.js";
import { validateCredentialLive } from "../ai/validateCredential.js";
import { ChevronDownIcon, ClockIcon, InfoIcon, ServerIcon } from "../ui/icons.js";
import "./CopilotError.css";
import {
  type CausePart,
  type CopilotFailure,
  type FailureActionId,
  type FailureCopy,
  describeFailure,
  failurePhase,
  interruptedCause,
} from "./failureCopy.js";

/**
 * The copilot's provider-failure UI: the four retry lifecycle states, all drawn by this file.
 *
 * The load-bearing decision is that **the block the user watches during backoff is the same block
 * that hardens into the failure card when attempts run out**. Nothing they were reading moves,
 * re-flows, or disappears at the moment of failure. That is why the ledger lives in one component
 * with a state prop rather than two components that swap.
 *
 * Everything here is presentational apart from two things it genuinely owns: the countdown tick and
 * the ledger disclosure. Phase transitions are driven by the retry wrapper, not by this component.
 */

/** Whole seconds, matching how `failureCopy` spells durations. */
function seconds(ms: number): string {
  return `${Math.max(0, Math.round(ms / 1000))}s`;
}

/** The glyph that sits in the 20×20 avatar gutter, chosen by what failed. */
function GlyphIcon({ glyph }: { glyph: FailureCopy["glyph"] }) {
  if (glyph === "clock") {
    return <ClockIcon size={13} />;
  }
  if (glyph === "server") {
    return <ServerIcon size={13} />;
  }
  // Same geometry the handoff specifies for `AlertCircleIcon` (circle r=9 + `M12 11v5` + `M12 8h.01`),
  // already in `icons.tsx` under this name — a byte-identical second copy would be dead weight.
  return <InfoIcon size={13} />;
}

/** Cause sentence with identifiers rendered in mono, as segments rather than parsed prose. */
function Cause({ parts }: { parts: CausePart[] }) {
  return (
    <p className="copilot-error__cause">
      {parts.map((part, index) =>
        typeof part === "string" ? (
          <span key={index}>{part}</span>
        ) : (
          <code key={index} className="copilot-error__mono-inline">
            {part.mono}
          </code>
        ),
      )}
    </p>
  );
}

/**
 * One ledger row. The three columns are a grid so attempt numbers and status codes align
 * vertically down the block — a ragged ledger is harder to scan than no ledger.
 */
function LedgerRow({ attempt, note }: { attempt: Attempt; note: string }) {
  return (
    <div className="copilot-error__row">
      <span>{attempt.n}</span>
      <span className="copilot-error__row-status">{attempt.status}</span>
      <span>{note}</span>
    </div>
  );
}

/** The note column for an attempt that already resolved. */
function settledNote(attempt: Attempt, isLast: boolean, terminal: string): string {
  if (attempt.waitedMs === undefined) {
    return isLast ? terminal : "";
  }
  // `retry-after` is annotated per row on purpose: it tells the user the wait was the provider's
  // instruction, not a delay we invented.
  return `waited ${seconds(attempt.waitedMs)}${attempt.fromRetryAfter ? " · retry-after" : ""}`;
}

/**
 * The attempt ledger. `terminal` is the note on the final row — "gave up" when the budget ran out,
 * "stopped" when a non-retryable status ended it early.
 */
function Ledger({
  attempts,
  terminal,
  requestId,
  pending,
  className,
}: {
  attempts: Attempt[];
  terminal: string;
  requestId?: string | undefined;
  /** A not-yet-made attempt, shown greyed so the user can see how many tries are left. */
  pending?: { n: number; note: string } | undefined;
  className: string;
}) {
  return (
    <div className={className}>
      {attempts.map((attempt, index) => (
        <LedgerRow
          key={attempt.n}
          attempt={attempt}
          note={settledNote(attempt, index === attempts.length - 1, terminal)}
        />
      ))}
      {pending ? (
        <div className="copilot-error__row copilot-error__row--pending">
          <span>{pending.n}</span>
          <span>—</span>
          <span>{pending.note}</span>
        </div>
      ) : null}
      {requestId ? (
        <div className="copilot-error__req">
          <span />
          <span title={requestId}>{requestId}</span>
        </div>
      ) : null}
    </div>
  );
}

/** A shell line worth running, with a copy button that confirms itself for a beat. */
function CommandRow({ command }: { command: string }) {
  const [copied, setCopied] = useState(false);
  const timerRef = useRef<number | undefined>(undefined);

  useEffect(() => () => window.clearTimeout(timerRef.current), []);

  return (
    <div className="copilot-error__command">
      <code>{command}</code>
      <button
        type="button"
        onClick={() => {
          void navigator.clipboard?.writeText(command);
          setCopied(true);
          window.clearTimeout(timerRef.current);
          timerRef.current = window.setTimeout(() => setCopied(false), 1600);
        }}
      >
        {copied ? "Copied" : "Copy"}
      </button>
    </div>
  );
}

export type CopilotErrorProps = {
  detail: CopilotFailure;
  /** Runs the card's primary action. The panel owns what each id means. */
  onAction: (id: FailureActionId) => void;
  onDismiss: () => void;
};

/**
 * The failure card in the assistant slot the reply would have occupied — same 20×20 avatar gutter
 * and 10px gap as a normal assistant turn, so the transcript's rhythm is unbroken. The user's
 * message above it stays untouched and visible: an infra failure belongs to the turn that caused
 * it, which is why nothing in this feature is a toast.
 *
 * The whole row lives here rather than in the panel so the severity is decided once, by the same
 * `describeFailure` call that writes the words — an avatar tinted differently from its card would
 * be a contradiction the user has to resolve.
 */
export function CopilotErrorRow(props: CopilotErrorProps) {
  const copy = describeFailure(props.detail);
  return (
    <div className="copilot-row copilot-row--assistant">
      <span className={`copilot-avatar copilot-avatar--${copy.severity}`} aria-hidden>
        <GlyphIcon glyph={copy.glyph} />
      </span>
      <div className="copilot-body">
        <CopilotError {...props} />
      </div>
    </div>
  );
}

function CopilotError({ detail, onAction, onDismiss }: CopilotErrorProps) {
  const copy = describeFailure(detail);
  const phase = failurePhase(detail);
  const attempts = detail.attempts ?? [];
  // Test-connection reports inline rather than opening a screen: the question it answers ("is the
  // server up now?") is the one the card is already asking.
  const [probe, setProbe] = useState<string | null>(null);

  const cause = phase === "interrupted" ? interruptedCause(detail) : copy.cause;

  return (
    <div className={`copilot-error copilot-error--${copy.severity}`}>
      <div className="copilot-error__head">
        <span className="copilot-error__title">{copy.title}</span>
        <span className="copilot-error__status">{copy.statusLabel}</span>
      </div>

      <Cause parts={cause} />

      {copy.bullets.length > 0 ? (
        <ul className="copilot-error__bullets">
          {copy.bullets.map((bullet) => (
            <li key={bullet}>{bullet}</li>
          ))}
        </ul>
      ) : null}

      {copy.command ? <CommandRow command={copy.command} /> : null}

      {attempts.length > 1 ? (
        <Ledger
          attempts={attempts}
          terminal={phase === "interrupted" ? "stopped" : "gave up"}
          requestId={detail.requestId}
          className="copilot-error__ledger copilot-error__ledger--inset"
        />
      ) : null}

      {probe ? <p className="copilot-error__probe">{probe}</p> : null}

      <div className="copilot-error__actions">
        {copy.primary && copy.primary.id !== "none" ? (
          <button
            type="button"
            className={
              copy.weakPrimary ? "copilot-error__btn" : "copilot-error__btn copilot-error__btn--go"
            }
            onClick={() => {
              if (copy.primary?.id === "test-connection") {
                setProbe("Checking…");
                void testConnection(detail).then(setProbe);
                return;
              }
              onAction(copy.primary!.id);
            }}
          >
            {copy.primary.label}
          </button>
        ) : null}
        <button type="button" className="copilot-error__btn" onClick={onDismiss}>
          Dismiss
        </button>
      </div>
    </div>
  );
}

/** Re-run the live credential check against the configured endpoint and report it in a sentence. */
async function testConnection(detail: CopilotFailure): Promise<string> {
  const endpoint =
    detail.failure.kind === "unreachable_local" ? detail.failure.endpoint : undefined;
  const result = await validateCredentialLive(detail.providerId, endpoint ?? "");
  if (result.ok) {
    return "The server answered — send the message again.";
  }
  return result.reason === "rejected"
    ? "The server answered but refused the request — check its auth settings."
    : "Still no answer from the server.";
}

/**
 * The live backoff block (`retrying`). Neutral, not an error: nothing has failed yet, and dressing
 * a wait in red would be a lie. This is the same box that hardens into the card above.
 */
export function CopilotRetrying({ progress }: { progress: RetryProgress }) {
  const [remainingMs, setRemainingMs] = useState(() =>
    Math.max(0, progress.nextAttemptAt - Date.now()),
  );

  // Derived from the absolute deadline on an interval, never by decrementing a counter: a
  // backgrounded tab throttles timers, and a decremented counter drifts out of sync with the real
  // wait — so the number on screen would stop matching what the wrapper is actually doing.
  useEffect(() => {
    const tick = () => setRemainingMs(Math.max(0, progress.nextAttemptAt - Date.now()));
    tick();
    const timer = window.setInterval(tick, 200);
    return () => window.clearInterval(timer);
  }, [progress.nextAttemptAt]);

  const { attempts, waitMs, maxAttempts, failure, context } = progress;
  const current = attempts[attempts.length - 1];
  const isRateLimit = failure.kind === "rate_limited";
  const label = isRateLimit ? "Rate limited" : `${context.label} is at capacity`;
  const detail = isRateLimit
    ? `${context.label} asked for ${seconds(waitMs)} before the next try.`
    : `Trying again in ${seconds(remainingMs)}.`;

  // Every settled row keeps its own note; the row we are waiting on reads "waiting", present tense.
  const rows = attempts.slice(0, -1);
  const waitingNote = `waiting ${seconds(remainingMs)}${current?.fromRetryAfter ? " · retry-after" : ""}`;

  return (
    <div className="copilot-retrying">
      <div className="copilot-retrying__head">
        <ClockIcon size={15} className="copilot-retrying__icon" />
        <span className="copilot-retrying__text">
          <strong>{label}</strong> · {detail}
        </span>
        <button type="button" className="copilot-retrying__stop" onClick={progress.stop}>
          Stop
        </button>
      </div>
      <div className="copilot-error__ledger copilot-retrying__ledger">
        {rows.map((attempt) => (
          <LedgerRow key={attempt.n} attempt={attempt} note={settledNote(attempt, false, "")} />
        ))}
        {current ? <LedgerRow attempt={current} note={waitingNote} /> : null}
        {attempts.length < maxAttempts ? (
          <div className="copilot-error__row copilot-error__row--pending">
            <span>{attempts.length + 1}</span>
            <span>—</span>
            <span>{attempts.length + 1 === maxAttempts ? "last attempt" : "queued"}</span>
          </div>
        ) : null}
      </div>
      {/* Scaled, not width-animated: transform stays off the layout path, and this runs while the
          panel is otherwise idle. The duration is the actual wait, so the bar cannot lie. */}
      <div className="copilot-retrying__track">
        <div
          className="copilot-retrying__bar"
          key={progress.nextAttemptAt}
          style={{ animationDuration: `${waitMs}ms` }}
        />
      </div>
    </div>
  );
}

/**
 * The one-line record a recovered turn wears above its reply. A successful turn should not carry
 * its history at full weight — keep the record, drop the volume — so it collapses to a single 11px
 * line with a disclosure, following the existing `.copilot-applied` pattern.
 */
export function CopilotRecovered({
  attempts,
  totalMs,
  stopped,
}: {
  attempts: Attempt[];
  totalMs: number;
  stopped?: boolean | undefined;
}) {
  const [open, setOpen] = useState(false);
  const codes = attempts.map((attempt) => String(attempt.status)).join(", ");
  const verb = stopped ? "Stopped after" : "Recovered after";

  return (
    <div className={`copilot-recovered${open ? " is-open" : ""}`}>
      <button
        type="button"
        className="copilot-recovered__head"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
      >
        <ClockIcon size={13} />
        <span className="copilot-recovered__summary">
          {verb} {attempts.length} {attempts.length === 1 ? "attempt" : "attempts"} ·{" "}
          <code>{codes}</code> · {seconds(totalMs)}
        </span>
        <ChevronDownIcon size={13} className="copilot-recovered__chevron" />
      </button>
      {open ? (
        <Ledger
          attempts={attempts}
          terminal={stopped ? "stopped" : "succeeded"}
          className="copilot-error__ledger copilot-recovered__ledger"
        />
      ) : null}
    </div>
  );
}
