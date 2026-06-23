import type { ApplyResult, Cardinality, Field, Schema, Source, Table } from "@schema-studio/core";
import { applyActions, emptySchema } from "@schema-studio/core";
import { create } from "zustand";
import { immer } from "zustand/middleware/immer";

import {
  type HistoryController,
  type Selection,
  type StoreSnapshot,
  canRedo,
  canUndo,
  clearCoalesce,
  cloneSnapshot,
  createHistoryController,
  pushHistory,
  redo,
  undo,
} from "./history.js";

export type RunActionsResult = Pick<ApplyResult, "applied" | "rejected">;

export type SchemaStore = {
  schema: Schema;
  sources: Source[];
  selection: Selection;

  runActions: (rawActions: unknown[]) => RunActionsResult;

  addTable: (name: string, opts?: { x?: number; y?: number }) => RunActionsResult;
  addField: (
    tableId: string,
    name: string,
    opts?: { type?: string; pk?: boolean; fk?: boolean },
  ) => RunActionsResult;
  removeField: (tableId: string, fieldId: string) => RunActionsResult;
  removeTable: (tableId: string) => RunActionsResult;
  renameTable: (tableId: string, name: string) => RunActionsResult;
  togglePk: (tableId: string, fieldId: string) => RunActionsResult;
  addRelationship: (
    fromTableId: string,
    fromFieldId: string,
    toTableId: string,
    toFieldId: string,
    cardinality?: Cardinality,
  ) => RunActionsResult;
  removeRelationship: (relationshipId: string) => RunActionsResult;
  setCardinality: (relationshipId: string, cardinality: Cardinality) => RunActionsResult;

  moveTable: (tableId: string, x: number, y: number) => void;
  moveTables: (positions: Array<{ tableId: string; x: number; y: number }>) => void;

  addSource: (source: Source) => void;
  removeSource: (sourceId: string) => void;

  selectTable: (tableId: string | undefined) => void;
  selectField: (tableId: string, fieldId: string) => void;
  clearSelection: () => void;

  undo: () => void;
  redo: () => void;
  canUndo: () => boolean;
  canRedo: () => boolean;
};

type SchemaStoreInternal = SchemaStore & {
  _history: HistoryController;
  _makeId: () => string;
};

export type CreateSchemaStoreOptions = {
  makeId?: () => string;
  initialSchema?: Schema;
  initialSources?: Source[];
};

function snapshotFromState(
  state: Pick<SchemaStore, "schema" | "sources" | "selection">,
): StoreSnapshot {
  return {
    schema: state.schema,
    sources: state.sources,
    selection: state.selection,
  };
}

function findTableById(schema: Schema, tableId: string): Table | undefined {
  return schema.tables.find((table) => table.id === tableId);
}

function findFieldById(table: Table, fieldId: string): Field | undefined {
  return table.fields.find((field) => field.id === fieldId);
}

function rejectUnknownTable(tableId: string, op: string): RunActionsResult {
  return {
    applied: [],
    rejected: [{ action: { op, tableId }, reason: `table '${tableId}' not found` }],
  };
}

function rejectUnknownField(tableId: string, fieldId: string, op: string): RunActionsResult {
  return {
    applied: [],
    rejected: [{ action: { op, tableId, fieldId }, reason: `field '${fieldId}' not found` }],
  };
}

function captureSnapshot(
  state: Pick<SchemaStore, "schema" | "sources" | "selection">,
): StoreSnapshot {
  return cloneSnapshot(snapshotFromState(state));
}

export function createSchemaStore(options?: CreateSchemaStoreOptions) {
  const makeId = options?.makeId ?? (() => crypto.randomUUID());

  return create<SchemaStoreInternal>()(
    immer((set, get) => {
      const commitSnapshot = (mutate: (draft: SchemaStoreInternal) => void): void => {
        const before = captureSnapshot(get());

        set((draft) => {
          clearCoalesce(draft._history);
          pushHistory(draft._history, before);
          mutate(draft);
        });
      };

      const runValidatedActions = (rawActions: unknown[]): RunActionsResult => {
        const state = get();
        const result = applyActions(state.schema, rawActions, { makeId: state._makeId });

        if (result.applied.length === 0) {
          return { applied: result.applied, rejected: result.rejected };
        }

        const before = captureSnapshot(state);

        set((draft) => {
          clearCoalesce(draft._history);
          pushHistory(draft._history, before);
          draft.schema = result.schema;
        });

        return { applied: result.applied, rejected: result.rejected };
      };

      return {
        schema: options?.initialSchema ?? emptySchema(),
        sources: options?.initialSources ?? [],
        selection: {},
        _history: createHistoryController(),
        _makeId: makeId,

        runActions: runValidatedActions,

        addTable: (name, opts) =>
          runValidatedActions([
            {
              op: "add_table",
              name,
              ...(opts?.x !== undefined ? { x: opts.x } : {}),
              ...(opts?.y !== undefined ? { y: opts.y } : {}),
            },
          ]),

        addField: (tableId, name, opts) => {
          const table = findTableById(get().schema, tableId);
          if (!table) {
            return rejectUnknownTable(tableId, "add_field");
          }

          return runValidatedActions([
            {
              op: "add_field",
              table: table.name,
              name,
              type: opts?.type ?? "text",
              pk: opts?.pk ?? false,
              fk: opts?.fk ?? false,
            },
          ]);
        },

        removeField: (tableId, fieldId) => {
          const table = findTableById(get().schema, tableId);
          if (!table) {
            return rejectUnknownTable(tableId, "remove_field");
          }

          const field = findFieldById(table, fieldId);
          if (!field) {
            return rejectUnknownField(tableId, fieldId, "remove_field");
          }

          return runValidatedActions([
            { op: "remove_field", table: table.name, field: field.name },
          ]);
        },

        removeTable: (tableId) => {
          const table = findTableById(get().schema, tableId);
          if (!table) {
            return rejectUnknownTable(tableId, "remove_table");
          }

          return runValidatedActions([{ op: "remove_table", table: table.name }]);
        },

        renameTable: (tableId, name) => {
          const table = findTableById(get().schema, tableId);
          if (!table) {
            return rejectUnknownTable(tableId, "rename_table");
          }

          return runValidatedActions([{ op: "rename_table", table: table.name, new_name: name }]);
        },

        togglePk: (tableId, fieldId) => {
          const table = findTableById(get().schema, tableId);
          if (!table) {
            return rejectUnknownTable(tableId, "toggle_pk");
          }

          const field = findFieldById(table, fieldId);
          if (!field) {
            return rejectUnknownField(tableId, fieldId, "toggle_pk");
          }

          commitSnapshot((draft) => {
            const draftTable = findTableById(draft.schema, tableId);
            const draftField = draftTable && findFieldById(draftTable, fieldId);
            if (draftField) {
              draftField.pk = !draftField.pk;
            }
          });

          return { applied: [{ op: "toggle_pk", tableIds: [tableId] }], rejected: [] };
        },

        addRelationship: (fromTableId, fromFieldId, toTableId, toFieldId, cardinality) => {
          const { schema } = get();
          const fromTable = findTableById(schema, fromTableId);
          if (!fromTable) {
            return rejectUnknownTable(fromTableId, "add_relationship");
          }

          const fromField = findFieldById(fromTable, fromFieldId);
          if (!fromField) {
            return rejectUnknownField(fromTableId, fromFieldId, "add_relationship");
          }

          const toTable = findTableById(schema, toTableId);
          if (!toTable) {
            return rejectUnknownTable(toTableId, "add_relationship");
          }

          const toField = findFieldById(toTable, toFieldId);
          if (!toField) {
            return rejectUnknownField(toTableId, toFieldId, "add_relationship");
          }

          return runValidatedActions([
            {
              op: "add_relationship",
              from_table: fromTable.name,
              from_field: fromField.name,
              to_table: toTable.name,
              to_field: toField.name,
              cardinality: cardinality ?? "1:N",
            },
          ]);
        },

        removeRelationship: (relationshipId) => {
          const relationship = get().schema.relationships.find(
            (candidate) => candidate.id === relationshipId,
          );
          if (!relationship) {
            return {
              applied: [],
              rejected: [
                {
                  action: { op: "remove_relationship", relationshipId },
                  reason: `relationship '${relationshipId}' not found`,
                },
              ],
            };
          }

          commitSnapshot((draft) => {
            draft.schema.relationships = draft.schema.relationships.filter(
              (candidate) => candidate.id !== relationshipId,
            );
          });

          return {
            applied: [
              {
                op: "remove_relationship",
                tableIds: [relationship.fromTable, relationship.toTable],
                relationshipId,
              },
            ],
            rejected: [],
          };
        },

        setCardinality: (relationshipId, cardinality) => {
          const relationship = get().schema.relationships.find(
            (candidate) => candidate.id === relationshipId,
          );
          if (!relationship) {
            return {
              applied: [],
              rejected: [
                {
                  action: { op: "set_cardinality", relationshipId, cardinality },
                  reason: `relationship '${relationshipId}' not found`,
                },
              ],
            };
          }

          commitSnapshot((draft) => {
            const draftRelationship = draft.schema.relationships.find(
              (candidate) => candidate.id === relationshipId,
            );
            if (draftRelationship) {
              draftRelationship.cardinality = cardinality;
            }
          });

          return {
            applied: [
              {
                op: "set_cardinality",
                tableIds: [relationship.fromTable, relationship.toTable],
                relationshipId,
              },
            ],
            rejected: [],
          };
        },

        moveTable: (tableId, x, y) => {
          const before = captureSnapshot(get());

          set((draft) => {
            const table = findTableById(draft.schema, tableId);
            if (!table) {
              return;
            }

            pushHistory(draft._history, before, `move:${tableId}`);
            table.x = x;
            table.y = y;
          });
        },

        moveTables: (positions) => {
          if (positions.length === 0) {
            return;
          }

          commitSnapshot((draft) => {
            for (const { tableId, x, y } of positions) {
              const table = findTableById(draft.schema, tableId);
              if (table) {
                table.x = x;
                table.y = y;
              }
            }
          });
        },

        addSource: (source) => {
          commitSnapshot((draft) => {
            draft.sources.push(source);
          });
        },

        removeSource: (sourceId) => {
          commitSnapshot((draft) => {
            draft.sources = draft.sources.filter((source) => source.id !== sourceId);
          });
        },

        selectTable: (tableId) => {
          set((draft) => {
            if (tableId === undefined) {
              delete draft.selection.tableId;
              delete draft.selection.fieldId;
              return;
            }

            draft.selection.tableId = tableId;
            delete draft.selection.fieldId;
          });
        },

        selectField: (tableId, fieldId) => {
          set((draft) => {
            draft.selection.tableId = tableId;
            draft.selection.fieldId = fieldId;
          });
        },

        clearSelection: () => {
          set((draft) => {
            delete draft.selection.tableId;
            delete draft.selection.fieldId;
          });
        },

        undo: () => {
          const current = captureSnapshot(get());

          set((draft) => {
            const restored = undo(draft._history, current);
            if (!restored) {
              return;
            }

            draft.schema = restored.schema;
            draft.sources = restored.sources;
            draft.selection = restored.selection;
          });
        },

        redo: () => {
          const current = captureSnapshot(get());

          set((draft) => {
            const restored = redo(draft._history, current);
            if (!restored) {
              return;
            }

            draft.schema = restored.schema;
            draft.sources = restored.sources;
            draft.selection = restored.selection;
          });
        },

        canUndo: () => canUndo(get()._history),
        canRedo: () => canRedo(get()._history),
      };
    }),
  );
}

export const useSchemaStore = createSchemaStore();
