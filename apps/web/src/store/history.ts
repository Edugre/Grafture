import type { Schema, Source } from "@schema-studio/core";

export type Selection = {
  tableId?: string;
  fieldId?: string;
};

export type StoreSnapshot = {
  schema: Schema;
  sources: Source[];
  selection: Selection;
};

export type HistoryController = {
  past: StoreSnapshot[];
  future: StoreSnapshot[];
  coalesceKey: string | null;
};

/**
 * Each snapshot deep-clones the schema and every source, so an unbounded stack grows memory
 * for the whole session. 100 undo steps is far more than anyone walks back; beyond that the
 * oldest snapshots are dropped.
 */
export const HISTORY_LIMIT = 100;

export function createHistoryController(): HistoryController {
  return { past: [], future: [], coalesceKey: null };
}

export function cloneSnapshot(snapshot: StoreSnapshot): StoreSnapshot {
  return {
    schema: structuredClone(snapshot.schema),
    sources: structuredClone(snapshot.sources),
    selection: { ...snapshot.selection },
  };
}

export function pushHistory(
  history: HistoryController,
  snapshot: StoreSnapshot,
  coalesceKey?: string,
): void {
  if (coalesceKey !== undefined && history.coalesceKey === coalesceKey) {
    return;
  }

  history.past.push(snapshot);
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

export function undo(history: HistoryController, current: StoreSnapshot): StoreSnapshot | null {
  const previous = history.past.pop();
  if (!previous) {
    return null;
  }

  history.future.push(current);
  history.coalesceKey = null;
  return previous;
}

export function redo(history: HistoryController, current: StoreSnapshot): StoreSnapshot | null {
  const next = history.future.pop();
  if (!next) {
    return null;
  }

  history.past.push(current);
  history.coalesceKey = null;
  return next;
}
