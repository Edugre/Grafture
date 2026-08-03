import type { Origin, Schema, Source } from "@grafture/core";

export type Selection = {
  tableId?: string;
  fieldId?: string;
};

export type StoreSnapshot = {
  schema: Schema;
  sources: Source[];
  selection: Selection;
};

/**
 * One undoable step. `snapshot` is the state **before** the change; `label`/`actor`/`at` describe
 * the change that was applied on top of it. Keeping the description glued to the step is what lets
 * the history box name each entry — a bare stack of snapshots can only say "100 steps".
 */
export type HistoryEntry = {
  snapshot: StoreSnapshot;
  label: string;
  /**
   * One line per action behind a batched step, so a row the label can only call "7 changes" can be
   * expanded into what it actually did. Empty on single-action steps.
   */
  details: string[];
  actor: Origin;
  at: number;
};

/** What a step is, minus the snapshot: everything the history box renders. */
export type HistoryStep = Pick<HistoryEntry, "label" | "details" | "actor" | "at">;

export type HistoryController = {
  past: HistoryEntry[];
  future: HistoryEntry[];
  coalesceKey: string | null;
};

/**
 * Each snapshot deep-clones the schema, so an unbounded stack grows memory for the whole
 * session. 100 undo steps is far more than anyone walks back; beyond that the oldest
 * snapshots are dropped.
 */
export const HISTORY_LIMIT = 100;

export function createHistoryController(): HistoryController {
  return { past: [], future: [], coalesceKey: null };
}

/**
 * Snapshots clone the schema but alias `sources` by reference. Sources are parsed once and
 * never mutated in place — every store command replaces the array (push/filter/assign) under
 * immer, which leaves the previous array object untouched — so the aliased reference stays a
 * faithful record of the pre-edit state.
 *
 * Cloning them instead is ruinous, not merely wasteful: a source carries `joinValues` (up to
 * MAX_JOIN_VALUES entries per field) and `sampleRows`. On the real HRSA + OPAIS pair one
 * snapshot measures ~68 MB, of which 96.5% is those two fields, and a full stack retains
 * ~5.8 GB — past the point where the tab survives. Stripping the heavy fields into the clone
 * is NOT the alternative: undo would then restore sources shorn of the wide join sets and
 * silently degrade detection, exactly the post-reload fallback the persistence layer accepts
 * only because a reload has no better option.
 */
export function cloneSnapshot(snapshot: StoreSnapshot): StoreSnapshot {
  return {
    schema: structuredClone(snapshot.schema),
    sources: snapshot.sources,
    selection: { ...snapshot.selection },
  };
}

/**
 * True when `pushHistory` would coalesce this key into the step already on the stack, so
 * callers can skip building a snapshot that is about to be discarded. A continuous drag emits
 * one command per pointer move and keeps only the first; without this guard every frame pays
 * for a snapshot nobody reads.
 */
export function willCoalesce(history: HistoryController, coalesceKey: string): boolean {
  return history.coalesceKey === coalesceKey;
}

export function pushHistory(
  history: HistoryController,
  entry: HistoryEntry,
  coalesceKey?: string,
): void {
  if (coalesceKey !== undefined && history.coalesceKey === coalesceKey) {
    return;
  }

  history.past.push(entry);
  if (history.past.length > HISTORY_LIMIT) {
    history.past.shift();
  }
  history.future = [];
  history.coalesceKey = coalesceKey ?? null;
}

export function clearCoalesce(history: HistoryController): void {
  history.coalesceKey = null;
}

export function canUndo(history: HistoryController): boolean {
  return history.past.length > 0;
}

export function canRedo(history: HistoryController): boolean {
  return history.future.length > 0;
}

/**
 * Move the top step from past to future. The label travels with it: the entry's snapshot swaps
 * for the current state (so redo can walk back), but the description stays attached to the change
 * it names, in either stack.
 */
export function undo(history: HistoryController, current: StoreSnapshot): HistoryEntry | null {
  const previous = history.past.pop();
  if (!previous) {
    return null;
  }

  history.future.push({ ...previous, snapshot: current });
  history.coalesceKey = null;
  return previous;
}

export function redo(history: HistoryController, current: StoreSnapshot): HistoryEntry | null {
  const next = history.future.pop();
  if (!next) {
    return null;
  }

  history.past.push({ ...next, snapshot: current });
  history.coalesceKey = null;
  return next;
}
