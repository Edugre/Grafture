import type { ApplyResult, Cardinality, Field, Schema, Source, Table } from "@schema-studio/core";
import { SchemaSchema, applyActions, emptySchema } from "@schema-studio/core";
import { create } from "zustand";
import { immer } from "zustand/middleware/immer";

import type { ChatMessage } from "../copilot/messages.js";
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

export type AcceptDraftResult = { ok: true } | { ok: false; error: string };

export type SchemaStore = {
  schema: Schema;
  sources: Source[];
  selection: Selection;
  chat: ChatMessage[];
  /**
   * IDs of content-aware suggestions the user has dismissed (see `suggest/useSuggestions`).
   * Ephemeral UI state shared by the Copilot Suggestions tab and the nudge toast so their
   * counts stay in sync; deliberately kept out of undo/redo and not persisted.
   */
  dismissedSuggestionIds: string[];
  /**
   * A not-yet-applied schema proposed by the AI (the New Project auto-draft). Rendered on the
   * canvas as a ghost overlay the user can Accept or Discard. Ephemeral UI state: kept out of
   * undo/redo and out of the autosaved project (the autosave subscription watches only
   * schema/sources/chat). Null when there's no pending proposal.
   */
  draft: Schema | null;

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
  renameField: (tableId: string, fieldId: string, name: string) => RunActionsResult;
  setFieldType: (tableId: string, fieldId: string, type: string) => RunActionsResult;
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
  resizeTable: (tableId: string, width: number) => void;

  addSource: (source: Source) => void;
  removeSource: (sourceId: string) => void;

  appendChatMessages: (messages: ChatMessage[]) => void;
  clearChat: () => void;

  dismissSuggestions: (ids: string[]) => void;

  /** Stash (or clear) the AI-proposed draft schema shown as a ghost overlay. No history entry. */
  setDraft: (schema: Schema | null) => void;
  /**
   * Apply the pending draft as the live schema in one undoable step, then clear it. Returns
   * whether the draft passed validation so the invoking surface can report a failure where
   * the user is actually looking (the chat error alone can sit in a hidden tab).
   */
  acceptDraft: () => AcceptDraftResult;
  /** Drop the pending draft without touching the schema. */
  discardDraft: () => void;

  loadProject: (schema: Schema, sources: Source[], chat?: ChatMessage[]) => void;

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
  initialChat?: ChatMessage[];
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

type ResolvedRelationshipEndpoints = {
  fromTable: Table;
  fromField: Field;
  toTable: Table;
  toField: Field;
};

/**
 * Resolve a relationship id to its `{table, field}` endpoint objects so a store command can
 * rebuild a name-based action for `applyActions` (the protocol addresses tables/fields by name,
 * not id). Returns a `RunActionsResult` carrying a surfaced rejection when the id is unknown or
 * its endpoints are dangling.
 */
function resolveRelationshipEndpoints(
  schema: Schema,
  relationshipId: string,
  op: string,
): ResolvedRelationshipEndpoints | RunActionsResult {
  const relationship = schema.relationships.find((candidate) => candidate.id === relationshipId);
  if (!relationship) {
    return {
      applied: [],
      rejected: [
        { action: { op, relationshipId }, reason: `relationship '${relationshipId}' not found` },
      ],
    };
  }

  const fromTable = findTableById(schema, relationship.fromTable);
  const toTable = findTableById(schema, relationship.toTable);
  const fromField = fromTable && findFieldById(fromTable, relationship.fromField);
  const toField = toTable && findFieldById(toTable, relationship.toField);

  if (!fromTable || !fromField || !toTable || !toField) {
    return {
      applied: [],
      rejected: [
        {
          action: { op, relationshipId },
          reason: `relationship '${relationshipId}' has dangling endpoints`,
        },
      ],
    };
  }

  return { fromTable, fromField, toTable, toField };
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
        chat: options?.initialChat ?? [],
        dismissedSuggestionIds: [],
        draft: null,
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
            return rejectUnknownTable(tableId, "set_pk");
          }

          const field = findFieldById(table, fieldId);
          if (!field) {
            return rejectUnknownField(tableId, fieldId, "set_pk");
          }

          return runValidatedActions([
            { op: "set_pk", table: table.name, field: field.name, pk: !field.pk },
          ]);
        },

        renameField: (tableId, fieldId, name) => {
          const table = findTableById(get().schema, tableId);
          if (!table) {
            return rejectUnknownTable(tableId, "rename_field");
          }

          const field = findFieldById(table, fieldId);
          if (!field) {
            return rejectUnknownField(tableId, fieldId, "rename_field");
          }

          const next = name.trim();
          if (!next || next === field.name) {
            return { applied: [], rejected: [] };
          }

          return runValidatedActions([
            { op: "rename_field", table: table.name, field: field.name, new_name: next },
          ]);
        },

        setFieldType: (tableId, fieldId, type) => {
          const table = findTableById(get().schema, tableId);
          if (!table) {
            return rejectUnknownTable(tableId, "set_type");
          }

          const field = findFieldById(table, fieldId);
          if (!field) {
            return rejectUnknownField(tableId, fieldId, "set_type");
          }

          const next = type.trim();
          if (!next || next === field.type) {
            return { applied: [], rejected: [] };
          }

          return runValidatedActions([
            { op: "set_type", table: table.name, field: field.name, type: next },
          ]);
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
          const endpoints = resolveRelationshipEndpoints(
            get().schema,
            relationshipId,
            "remove_relationship",
          );
          if ("rejected" in endpoints) {
            return endpoints;
          }

          const { fromTable, fromField, toTable, toField } = endpoints;
          return runValidatedActions([
            {
              op: "remove_relationship",
              from_table: fromTable.name,
              from_field: fromField.name,
              to_table: toTable.name,
              to_field: toField.name,
            },
          ]);
        },

        setCardinality: (relationshipId, cardinality) => {
          const endpoints = resolveRelationshipEndpoints(
            get().schema,
            relationshipId,
            "set_cardinality",
          );
          if ("rejected" in endpoints) {
            return endpoints;
          }

          const { fromTable, fromField, toTable, toField } = endpoints;
          return runValidatedActions([
            {
              op: "set_cardinality",
              from_table: fromTable.name,
              from_field: fromField.name,
              to_table: toTable.name,
              to_field: toField.name,
              cardinality,
            },
          ]);
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

        resizeTable: (tableId, width) => {
          const before = captureSnapshot(get());

          set((draft) => {
            const table = findTableById(draft.schema, tableId);
            if (!table) {
              return;
            }

            // Coalesce a continuous drag-resize into a single undo step.
            pushHistory(draft._history, before, `resize:${tableId}`);
            table.width = width;
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

        // Chat is deliberately kept out of the undo/redo history — undoing a schema edit
        // should not also erase the conversation that produced it.
        appendChatMessages: (messages) => {
          if (messages.length === 0) {
            return;
          }
          set((draft) => {
            draft.chat.push(...messages);
          });
        },

        clearChat: () => {
          set((draft) => {
            draft.chat = [];
          });
        },

        // Hide one or more suggestions without applying them. Not part of undo/redo —
        // dismissing a nudge shouldn't be entangled with schema history.
        dismissSuggestions: (ids) => {
          if (ids.length === 0) {
            return;
          }
          set((draft) => {
            const seen = new Set(draft.dismissedSuggestionIds);
            for (const id of ids) {
              if (!seen.has(id)) {
                seen.add(id);
                draft.dismissedSuggestionIds.push(id);
              }
            }
          });
        },

        // Replace the entire working set when switching local projects. History is
        // reset so undo never crosses a project boundary.
        setDraft: (schema) => {
          set((state) => {
            state.draft = schema ? structuredClone(schema) : null;
          });
        },

        acceptDraft: () => {
          const proposed = get().draft;
          if (!proposed) {
            return { ok: true };
          }
          // The draft was built through applyActions, but re-check the contract before the
          // wholesale swap — an invalid proposal is surfaced and discarded, never installed.
          const parsed = SchemaSchema.safeParse(proposed);
          if (!parsed.success) {
            const error = "The drafted schema failed validation and was discarded.";
            set((state) => {
              state.draft = null;
              state.chat.push({ id: state._makeId(), role: "error", text: error });
            });
            return { ok: false, error };
          }
          commitSnapshot((state) => {
            state.schema = parsed.data;
            state.draft = null;
          });
          return { ok: true };
        },

        discardDraft: () => {
          set((state) => {
            state.draft = null;
          });
        },

        loadProject: (schema, sources, chat = []) => {
          set((state) => {
            state.schema = structuredClone(schema);
            state.sources = structuredClone(sources);
            state.chat = structuredClone(chat);
            state.selection = {};
            state.dismissedSuggestionIds = [];
            state.draft = null;
            state._history = createHistoryController();
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
