import type {
  ApplyResult,
  Cardinality,
  Field,
  Origin,
  Schema,
  Source,
  Table,
} from "@grafture/core";
import { SchemaSchema, applyActions, emptySchema } from "@grafture/core";
import { create } from "zustand";
import { immer } from "zustand/middleware/immer";

import type { ChatMessage } from "../copilot/messages.js";
import { describeChange } from "./changeLabel.js";
import {
  type HistoryController,
  type HistoryEntry,
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
  willCoalesce,
} from "./history.js";

export type RunActionsResult = Pick<ApplyResult, "applied" | "rejected">;

/**
 * Which entity's rationale the review panel is showing. Stored as ids rather than a snapshot of
 * the rationale so the panel always reads live provenance — an explanation that goes stale while
 * open must say so rather than keep rendering the state it was opened in.
 */
export type RationaleFocus =
  | { kind: "table"; tableId: string }
  | { kind: "field"; tableId: string; fieldId: string }
  | { kind: "relationship"; relationshipId: string };

export type RunActionsOptions = {
  actor?: Origin;
  /** Groups a copilot turn's rationales in the review panel. Set only on the copilot path. */
  turnId?: string;
};

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
   * Whether the canvas shows provenance markers and rationale badges. Off by default and switched
   * on automatically after a copilot turn: "who made this" matters intensely while reviewing a
   * fresh proposal and hardly at all a week later, so it is a mode rather than permanent chrome
   * competing with genuinely transient canvas state. Ephemeral UI state — out of undo/redo, not
   * persisted.
   */
  reviewMode: boolean;
  /** The rationale open in the review panel, or null. Ephemeral UI state, like `reviewMode`. */
  rationaleFocus: RationaleFocus | null;
  /**
   * A not-yet-applied schema proposed by the AI (the New Project auto-draft). Rendered on the
   * canvas as a ghost overlay the user can Accept or Discard. Ephemeral UI state: kept out of
   * undo/redo and out of the autosaved project (the autosave subscription watches only
   * schema/sources/chat). Null when there's no pending proposal.
   */
  draft: Schema | null;

  /**
   * Apply a batch of actions, attributing them to `opts.actor`. Every caller declares who is
   * acting: the copilot passes `"ai"`, building a table from a parsed file passes `"imported"`,
   * and everything else takes the `"user"` default. Core cannot infer this — manual edits and
   * copilot output share this one path.
   */
  runActions: (rawActions: unknown[], opts?: RunActionsOptions) => RunActionsResult;

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
  /** Add several sources (e.g. a JSON parent + its unnested children) as ONE undo step. */
  addSources: (sources: Source[]) => void;
  removeSource: (sourceId: string) => void;

  appendChatMessages: (messages: ChatMessage[]) => void;
  /** Drop one message — how a dismissed copilot failure card leaves the transcript. */
  removeChatMessage: (id: string) => void;
  clearChat: () => void;

  dismissSuggestions: (ids: string[]) => void;

  setReviewMode: (on: boolean) => void;
  focusRationale: (focus: RationaleFocus | null) => void;

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
  /**
   * Walk several steps at once: negative undoes, positive redoes. This is what clicking an entry
   * in the history box does — jumping to a step is n undos or n redos, so it takes exactly the
   * same path as the buttons rather than restoring a snapshot out of band.
   */
  travel: (steps: number) => void;
  canUndo: () => boolean;
  canRedo: () => boolean;

  /**
   * The undo/redo stacks, each step carrying a label and the actor that made it, so the history
   * box can list what happened instead of only how much did. **Read-only for the UI** — it is
   * mutated only by the commands above, which is what keeps undo/redo correct.
   */
  history: HistoryController;
};

type SchemaStoreInternal = SchemaStore & {
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
      /**
       * Push one labelled history step, then mutate. `label`/`actor` describe the change about to
       * be made — every command names its own step, because the store is the only place that
       * knows both what happened and who asked for it.
       */
      const commitSnapshot = (
        step: Pick<HistoryEntry, "label" | "actor"> & Partial<Pick<HistoryEntry, "details">>,
        mutate: (draft: SchemaStoreInternal) => void,
      ): void => {
        const before = captureSnapshot(get());

        set((draft) => {
          clearCoalesce(draft.history);
          pushHistory(draft.history, {
            details: [],
            ...step,
            snapshot: before,
            at: Date.now(),
          });
          mutate(draft);
        });
      };

      const runValidatedActions = (
        rawActions: unknown[],
        opts?: RunActionsOptions,
      ): RunActionsResult => {
        const state = get();
        const result = applyActions(state.schema, rawActions, {
          makeId: state._makeId,
          ...(opts?.actor === undefined ? {} : { actor: opts.actor }),
          ...(opts?.turnId === undefined ? {} : { turnId: opts.turnId }),
        });

        if (result.applied.length === 0) {
          return { applied: result.applied, rejected: result.rejected };
        }

        const before = captureSnapshot(state);
        const { label, details } = describeChange(state.schema, result.schema, result.applied);
        const actor = opts?.actor ?? "user";

        set((draft) => {
          clearCoalesce(draft.history);
          pushHistory(draft.history, { snapshot: before, label, details, actor, at: Date.now() });
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
        reviewMode: false,
        rationaleFocus: null,
        draft: null,
        history: createHistoryController(),
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
          const state = get();
          const coalesceKey = `move:${tableId}`;
          // Mid-drag the snapshot would be coalesced away; don't build it at all.
          const before = willCoalesce(state.history, coalesceKey) ? null : captureSnapshot(state);
          const name = findTableById(state.schema, tableId)?.name ?? "table";

          set((draft) => {
            const table = findTableById(draft.schema, tableId);
            if (!table) {
              return;
            }

            if (before) {
              pushHistory(
                draft.history,
                {
                  snapshot: before,
                  label: `Move ${name}`,
                  details: [],
                  actor: "user",
                  at: Date.now(),
                },
                coalesceKey,
              );
            }
            table.x = x;
            table.y = y;
          });
        },

        moveTables: (positions) => {
          if (positions.length === 0) {
            return;
          }

          const label =
            positions.length === 1
              ? `Move ${findTableById(get().schema, positions[0]!.tableId)?.name ?? "table"}`
              : `Move ${positions.length} tables`;

          commitSnapshot({ label, actor: "user" }, (draft) => {
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
          const state = get();
          // Coalesce a continuous drag-resize into a single undo step, and skip the snapshot
          // entirely once coalescing has started.
          const coalesceKey = `resize:${tableId}`;
          const before = willCoalesce(state.history, coalesceKey) ? null : captureSnapshot(state);
          const name = findTableById(state.schema, tableId)?.name ?? "table";

          set((draft) => {
            const table = findTableById(draft.schema, tableId);
            if (!table) {
              return;
            }

            if (before) {
              pushHistory(
                draft.history,
                {
                  snapshot: before,
                  label: `Resize ${name}`,
                  details: [],
                  actor: "user",
                  at: Date.now(),
                },
                coalesceKey,
              );
            }
            table.width = width;
          });
        },

        addSource: (source) => {
          commitSnapshot({ label: `Add source ${source.name}`, actor: "imported" }, (draft) => {
            draft.sources.push(source);
          });
        },

        addSources: (sources) => {
          if (sources.length === 0) {
            return;
          }
          // One snapshot for the whole batch: a JSON file that unnests into N+1 sources must
          // be one undo step, not N+1.
          const label =
            sources.length === 1
              ? `Add source ${sources[0]!.name}`
              : `Add ${sources.length} sources`;
          commitSnapshot({ label, actor: "imported" }, (draft) => {
            draft.sources.push(...sources);
          });
        },

        // Removing a JSON parent also removes the children unnested from its array fields: they
        // exist only as part of that file, and a child whose parent is gone loses the lineage its
        // `_parentId` link depends on. Mirrors `addSources` — one file in, one file out, one undo.
        removeSource: (sourceId) => {
          const name = get().sources.find((source) => source.id === sourceId)?.name ?? "source";
          commitSnapshot({ label: `Remove source ${name}`, actor: "user" }, (draft) => {
            draft.sources = draft.sources.filter(
              (source) => source.id !== sourceId && source.derivedFrom?.parentId !== sourceId,
            );
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

        removeChatMessage: (id) => {
          set((draft) => {
            draft.chat = draft.chat.filter((message) => message.id !== id);
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

        // Not undoable: toggling a view is not a schema edit, and putting it in history would
        // make undo restore a display mode instead of the user's last real change.
        setReviewMode: (on) => {
          set((state) => {
            state.reviewMode = on;
            // Leaving review mode closes the panel: it explains markers that are no longer shown.
            if (!on) {
              state.rationaleFocus = null;
            }
          });
        },

        focusRationale: (focus) => {
          set((state) => {
            state.rationaleFocus = focus;
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
          const added = parsed.data.tables.length - get().schema.tables.length;
          commitSnapshot(
            {
              label: added > 0 ? `Accept AI draft (${added} tables)` : "Accept AI draft",
              actor: "ai",
            },
            (state) => {
              state.schema = parsed.data;
              state.draft = null;
              // Same rule as the chat path: accepting a copilot proposal is exactly the moment
              // "who made this, and why" is worth the screen space. The auto-draft never goes
              // through `runActions`, so it cannot inherit that from there.
              state.reviewMode = true;
            },
          );
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
            // A review of the previous project's proposal means nothing here, and the focused
            // ids belong to a schema that is no longer loaded.
            state.reviewMode = false;
            state.rationaleFocus = null;
            state.draft = null;
            state.history = createHistoryController();
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
            const restored = undo(draft.history, current);
            if (!restored) {
              return;
            }

            draft.schema = restored.snapshot.schema;
            draft.sources = restored.snapshot.sources;
            draft.selection = restored.snapshot.selection;
          });
        },

        redo: () => {
          const current = captureSnapshot(get());

          set((draft) => {
            const restored = redo(draft.history, current);
            if (!restored) {
              return;
            }

            draft.schema = restored.snapshot.schema;
            draft.sources = restored.snapshot.sources;
            draft.selection = restored.snapshot.selection;
          });
        },

        // Repeated single steps rather than one long jump: each hop swaps a snapshot into the
        // opposite stack, so walking them one at a time is what leaves both stacks — and the
        // labels the history box reads off them — consistent at the destination.
        travel: (steps) => {
          const move = steps < 0 ? get().undo : get().redo;
          for (let taken = 0; taken < Math.abs(steps); taken += 1) {
            move();
          }
        },

        canUndo: () => canUndo(get().history),
        canRedo: () => canRedo(get().history),
      };
    }),
  );
}

export const useSchemaStore = createSchemaStore();
