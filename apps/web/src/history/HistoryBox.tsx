import { useEffect, useMemo, useRef, useState } from "react";

import { provenanceLabel } from "../canvas/provenance.js";
import { formatRelativeTime } from "../home/relativeTime.js";
import { type HistoryEntry, useSchemaStore } from "../store/index.js";
import { ChevronDownIcon, ClockIcon } from "../ui/icons.js";
import "./HistoryBox.css";

/**
 * One row in the box. `offset` is what `travel` is called with to land on this row: negative rows
 * are undos back through applied steps, positive rows are redos forward into undone ones, and 0 is
 * where the schema stands right now.
 */
type HistoryRow = {
  key: string;
  label: string;
  /** The actions behind a batched step. Empty when the label already says everything. */
  details: string[];
  actor: HistoryEntry["actor"] | null;
  at: number | null;
  offset: number;
  undone: boolean;
};

const ACTOR_LABEL: Record<HistoryEntry["actor"], string> = {
  ai: "AI",
  user: "You",
  imported: "File",
};

/**
 * Newest change first, undone ones above the current position — the same reading order as the
 * canvas's undo button walking backwards. `future` is a stack pushed on each undo, so index 0 is
 * the most recently made change and the last element is the next redo; `past` is the reverse.
 */
function buildRows(past: HistoryEntry[], future: HistoryEntry[]): HistoryRow[] {
  const rows: HistoryRow[] = future.map((entry, index) => ({
    key: `future-${index}`,
    label: entry.label,
    details: entry.details,
    actor: entry.actor,
    at: entry.at,
    offset: future.length - index,
    undone: true,
  }));

  for (let index = past.length - 1; index >= 0; index -= 1) {
    const entry = past[index]!;
    rows.push({
      key: `past-${index}`,
      label: entry.label,
      details: entry.details,
      actor: entry.actor,
      at: entry.at,
      offset: -(past.length - 1 - index),
      undone: false,
    });
  }

  // The state the project opened in. Always the floor of the stack, so it is always reachable.
  rows.push({
    key: "base",
    label: "Initial state",
    details: [],
    actor: null,
    at: null,
    offset: -past.length,
    undone: false,
  });

  return rows;
}

export function HistoryBox() {
  const past = useSchemaStore((state) => state.history.past);
  const future = useSchemaStore((state) => state.history.future);
  const travel = useSchemaStore((state) => state.travel);

  const [open, setOpen] = useState(false);
  // Which batched steps are expanded. Keyed by row key, which is positional — a step that moves
  // between the stacks is a different row, and inheriting a neighbour's open state would be worse
  // than collapsing.
  const [expanded, setExpanded] = useState<string[]>([]);
  const rootRef = useRef<HTMLDivElement>(null);

  const rows = useMemo(() => buildRows(past, future), [past, future]);
  const count = past.length;
  const hasSteps = past.length > 0 || future.length > 0;

  // Dismiss like any other popover: click outside or Esc.
  useEffect(() => {
    if (!open) {
      return;
    }
    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpen(false);
      }
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  return (
    <div className="history-box" ref={rootRef}>
      <button
        type="button"
        className={`canvas-tools__icon${open ? " is-active" : ""}`}
        onClick={() => setOpen((value) => !value)}
        title="History"
        aria-label="History"
        aria-expanded={open}
      >
        <ClockIcon size={15} />
      </button>

      {open ? (
        <div className="history-box__panel" role="dialog" aria-label="Change history">
          <div className="history-box__head">
            <span className="history-box__title">History</span>
            <span className="history-box__count">
              {count} {count === 1 ? "step" : "steps"}
            </span>
          </div>
          {hasSteps ? (
            <ul className="history-box__list">
              {rows.map((row) => {
                const isOpen = expanded.includes(row.key);
                return (
                  <li key={row.key}>
                    <div className="history-box__entry">
                      <button
                        type="button"
                        className={`history-box__row${row.undone ? " is-undone" : ""}${
                          row.offset === 0 ? " is-current" : ""
                        }`}
                        onClick={() => travel(row.offset)}
                        disabled={row.offset === 0}
                        title={
                          row.offset === 0
                            ? "Current state"
                            : row.offset > 0
                              ? `Redo ${row.offset} ${row.offset === 1 ? "step" : "steps"}`
                              : `Undo ${-row.offset} ${row.offset === -1 ? "step" : "steps"}`
                        }
                      >
                        {row.actor ? (
                          // The canvas's provenance marker, reused verbatim: "who made this" must
                          // look the same wherever it is asked.
                          <span
                            className="provenance-dot"
                            data-origin={row.actor}
                            title={provenanceLabel(row.actor, { what: "Changed" })}
                          />
                        ) : (
                          <span className="history-box__base-dot" aria-hidden />
                        )}
                        <span className="history-box__label">{row.label}</span>
                        {row.actor ? (
                          <span className="history-box__actor">{ACTOR_LABEL[row.actor]}</span>
                        ) : null}
                        {row.at === null ? null : (
                          <span className="history-box__time">{formatRelativeTime(row.at)}</span>
                        )}
                      </button>
                      {/* A sibling, not a nested button: expanding a batch to read it must never be
                          the same click as jumping the schema to it. */}
                      {row.details.length > 0 ? (
                        <button
                          type="button"
                          className={`history-box__disclosure${isOpen ? " is-open" : ""}`}
                          onClick={() =>
                            setExpanded((keys) =>
                              isOpen ? keys.filter((key) => key !== row.key) : [...keys, row.key],
                            )
                          }
                          aria-expanded={isOpen}
                          aria-label={`${isOpen ? "Hide" : "Show"} the ${row.details.length} changes in this step`}
                          title={isOpen ? "Hide changes" : "Show changes"}
                        >
                          <ChevronDownIcon size={12} />
                        </button>
                      ) : null}
                    </div>
                    {isOpen ? (
                      <ul className="history-box__details">
                        {row.details.map((detail, index) => (
                          <li key={`${row.key}-${index}`} className="history-box__detail">
                            {detail}
                          </li>
                        ))}
                      </ul>
                    ) : null}
                  </li>
                );
              })}
            </ul>
          ) : (
            <p className="history-box__empty">Edits you or the AI make show up here.</p>
          )}
        </div>
      ) : null}
    </div>
  );
}
