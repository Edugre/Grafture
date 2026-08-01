import { useMemo } from "react";

import { detectJoinKeys } from "@grafture/core";

import { useSchemaStore } from "../store/index.js";
import {
  buildApplyPlan,
  buildJoinSuggestions,
  buildKeySuggestions,
  buildSetPkPlan,
  buildSetTypePlan,
  buildTypeSuggestions,
  type JoinSuggestion,
  type KeySuggestion,
  type TypeSuggestion,
} from "./joinSuggestions.js";

/**
 * One reviewable suggestion, normalized across the three detector kinds so the Suggestions tab,
 * the footer, and the nudge toast all read from a single derived list (counts stay in sync).
 *
 * The handoff's "Couldn't infer" caution group has no backing detector yet (per CLAUDE.md we
 * don't invent detector behavior), so it's intentionally absent — `needsReview` instead flags
 * actionable joins that require normalization before they'll match (format-mismatch warnings),
 * which is the amber "needs review" signal the toast/footer surface.
 */
export type SuggestionItem =
  | { id: string; group: "pk"; needsReview: false; key: KeySuggestion }
  | { id: string; group: "fk"; needsReview: boolean; join: JoinSuggestion }
  | { id: string; group: "type"; needsReview: false; type: TypeSuggestion };

export type SuggestionGroup = {
  key: "pk" | "fk" | "type";
  label: string;
  items: SuggestionItem[];
};

export type ApplyOutcome = { ok: true; label: string } | { ok: false; error: string };

export type SuggestionsApi = {
  /** Open (not-yet-applied, not-dismissed) suggestions, grouped for display in handoff order. */
  groups: SuggestionGroup[];
  /** Flat list of open items, in group order — used for "Apply all" and toast change-detection. */
  open: SuggestionItem[];
  openCount: number;
  /** Open joins that need normalization before they'll match (amber "needs review"). */
  needsReviewCount: number;
  /** Distinct sources that fed these suggestions ("across N files"). */
  fileCount: number;
  apply: (item: SuggestionItem) => ApplyOutcome;
  dismiss: (id: string) => void;
  dismissAll: () => void;
};

const GROUP_LABEL: Record<SuggestionGroup["key"], string> = {
  pk: "Primary keys",
  fk: "Foreign keys & relationships",
  type: "Types",
};

/**
 * Derive the reviewable content-aware suggestions from the loaded sources + current schema and
 * expose apply/dismiss helpers. Everything runs locally over the parsed sample values (no AI, no
 * network); "apply" still flows through the validated store path (`runActions`).
 */
export function useSuggestions(): SuggestionsApi {
  const sources = useSchemaStore((state) => state.sources);
  const schema = useSchemaStore((state) => state.schema);
  const dismissedIds = useSchemaStore((state) => state.dismissedSuggestionIds);
  const runActions = useSchemaStore((state) => state.runActions);
  const selectTable = useSchemaStore((state) => state.selectTable);
  const dismissSuggestions = useSchemaStore((state) => state.dismissSuggestions);

  // The detection pass normalizes and intersects the wide join-value sets — expensive with
  // large files — and depends only on the parsed sources, so it must not re-run on schema
  // edits (every table drag, rename, or undo produces a new schema object).
  const joinCandidates = useMemo(() => detectJoinKeys(sources), [sources]);

  const groups = useMemo<SuggestionGroup[]>(() => {
    const dismissed = new Set(dismissedIds);

    const keyItems: SuggestionItem[] = buildKeySuggestions(sources, schema)
      .filter((key) => !dismissed.has(key.id))
      .map((key) => ({ id: key.id, group: "pk", needsReview: false, key }));

    const joinItems: SuggestionItem[] = buildJoinSuggestions(joinCandidates, schema)
      .filter((join) => !join.alreadyLinked && !dismissed.has(join.id))
      .map((join) => ({
        id: join.id,
        group: "fk",
        needsReview: join.warning !== null,
        join,
      }));

    const typeItems: SuggestionItem[] = buildTypeSuggestions(sources, schema)
      .filter((type) => !dismissed.has(type.id))
      .map((type) => ({ id: type.id, group: "type", needsReview: false, type }));

    return (
      [
        { key: "pk" as const, label: GROUP_LABEL.pk, items: keyItems },
        { key: "fk" as const, label: GROUP_LABEL.fk, items: joinItems },
        { key: "type" as const, label: GROUP_LABEL.type, items: typeItems },
      ] satisfies SuggestionGroup[]
    ).filter((group) => group.items.length > 0);
  }, [sources, schema, dismissedIds, joinCandidates]);

  return useMemo<SuggestionsApi>(() => {
    const open = groups.flatMap((group) => group.items);

    // Applying a suggestion takes the default `user` actor rather than `ai`, deliberately: these
    // are deterministic detector findings the user reviewed and accepted, with no model involved
    // anywhere in the path. Stamping them `ai` would make the canvas claim the copilot authored
    // something it never saw — and would show a provenance marker with no rationale behind it.
    const apply = (item: SuggestionItem): ApplyOutcome => {
      if (item.group === "fk") {
        const plan = buildApplyPlan(sources, schema, item.join.candidate);
        if (!plan.ok) {
          return { ok: false, error: plan.error };
        }
        const { applied, rejected } = runActions(plan.actions);
        if (rejected.length > 0) {
          return { ok: false, error: rejected.map((entry) => entry.reason).join("; ") };
        }
        const linkedTableId = applied.at(-1)?.tableIds[0];
        if (linkedTableId) {
          selectTable(linkedTableId);
        }
        const built = plan.builtTables.length > 0 ? ` (built ${plan.builtTables.join(", ")})` : "";
        return { ok: true, label: `Linked on ${item.join.candidate.left.field}${built}.` };
      }

      if (item.group === "pk") {
        const { actions } = buildSetPkPlan(item.key);
        const { applied, rejected } = runActions(actions);
        if (rejected.length > 0) {
          return { ok: false, error: rejected.map((entry) => entry.reason).join("; ") };
        }
        const tableId = applied.at(-1)?.tableIds[0];
        if (tableId) {
          selectTable(tableId);
        }
        return {
          ok: true,
          label: `Set ${item.key.candidate.field} as the primary key of ${item.key.tableName}.`,
        };
      }

      const { actions } = buildSetTypePlan(item.type);
      const { applied, rejected } = runActions(actions);
      if (rejected.length > 0) {
        return { ok: false, error: rejected.map((entry) => entry.reason).join("; ") };
      }
      const tableId = applied.at(-1)?.tableIds[0];
      if (tableId) {
        selectTable(tableId);
      }
      return { ok: true, label: `Set ${item.type.field} to ${item.type.suggestedType}.` };
    };

    return {
      groups,
      open,
      openCount: open.length,
      needsReviewCount: open.filter((item) => item.needsReview).length,
      fileCount: sources.length,
      apply,
      dismiss: (id: string) => dismissSuggestions([id]),
      dismissAll: () => dismissSuggestions(open.map((item) => item.id)),
    };
  }, [groups, sources, schema, runActions, selectTable, dismissSuggestions]);
}
