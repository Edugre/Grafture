import type {
  Cardinality,
  Grain,
  JoinKeyCandidate,
  PrimaryKeyCandidate,
  Schema,
  Source,
} from "@schema-studio/core";
import { detectJoinKeys, detectPrimaryKeys } from "@schema-studio/core";

import { tableNameFromFilename } from "../sources/tableName.js";

/**
 * SS-9b — surface the core content-aware detectors (SS-9) as reviewable suggestions.
 *
 * `detectJoinKeys` reasons over the *sample values* captured at parse time (not column
 * names) to propose cross-source join keys and flag identifier columns that won't match
 * without normalization. This module turns those raw candidates into view models the UI
 * can render, and into validated `applyActions` payloads — so "Apply" still flows through
 * the single typed path, never a direct mutation.
 */

export type JoinSuggestion = {
  /** Stable key for React + dedupe. */
  id: string;
  candidate: JoinKeyCandidate;
  leftLabel: string;
  rightLabel: string;
  /** Normalized overlap as a whole-number percent. */
  overlapPercent: number;
  sharedValues: number;
  /** Non-null when the columns need normalization before they'll join. */
  warning: string | null;
  /** Inferred relationship grain for display, e.g. "1:N"; null when undetermined. */
  grainLabel: string | null;
  /** True once both sides are linked in the schema — used to hide done suggestions. */
  alreadyLinked: boolean;
};

const MAX_SUGGESTIONS = 6;

function fieldNamesEqual(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

/**
 * Does the schema already contain a relationship between the two candidate columns?
 * Compared by field *name* (unordered) since suggestions are source-level, not id-level.
 */
function isAlreadyLinked(schema: Schema, candidate: JoinKeyCandidate): boolean {
  const fieldNameById = new Map<string, string>();
  for (const table of schema.tables) {
    for (const field of table.fields) {
      fieldNameById.set(field.id, field.name);
    }
  }

  return schema.relationships.some((relationship) => {
    const from = fieldNameById.get(relationship.fromField);
    const to = fieldNameById.get(relationship.toField);
    if (from === undefined || to === undefined) {
      return false;
    }
    const matchForward =
      fieldNamesEqual(from, candidate.left.field) && fieldNamesEqual(to, candidate.right.field);
    const matchReverse =
      fieldNamesEqual(from, candidate.right.field) && fieldNamesEqual(to, candidate.left.field);
    return matchForward || matchReverse;
  });
}

/** Run the detectors over the loaded sources and shape the results for display. */
export function buildJoinSuggestions(sources: Source[], schema: Schema): JoinSuggestion[] {
  const candidates = detectJoinKeys(sources);

  return candidates.slice(0, MAX_SUGGESTIONS).map((candidate) => ({
    id: `${candidate.left.sourceId}:${candidate.left.field}->${candidate.right.sourceId}:${candidate.right.field}`,
    candidate,
    leftLabel: `${candidate.left.sourceName} · ${candidate.left.field}`,
    rightLabel: `${candidate.right.sourceName} · ${candidate.right.field}`,
    overlapPercent: Math.round(candidate.normalizedOverlap * 100),
    sharedValues: candidate.sharedValues,
    warning: candidate.formatMismatch ? candidate.formatMismatch.note : null,
    grainLabel: candidate.grain === "unknown" ? null : candidate.grain,
    alreadyLinked: isAlreadyLinked(schema, candidate),
  }));
}

function tableForSource(schema: Schema, source: Source, fieldName: string) {
  const base = tableNameFromFilename(source.name).toLowerCase();
  const hasField = (table: Schema["tables"][number]) =>
    table.fields.some((field) => fieldNamesEqual(field.name, fieldName));

  return (
    schema.tables.find((table) => table.name.toLowerCase() === base && hasField(table)) ??
    schema.tables.find((table) => table.name.toLowerCase().startsWith(base) && hasField(table)) ??
    schema.tables.find(hasField)
  );
}

export type ApplyPlan =
  | { ok: true; actions: unknown[]; builtTables: string[] }
  | { ok: false; error: string };

/**
 * Translate inferred grain into a relationship the schema model can hold. The model only has
 * "1:1" | "1:N" | "N:M", so a many-to-one (`N:1`) is expressed as a `1:N` with the direction
 * flipped — the FK points from the "many" side to the unique "one" side. `unknown` keeps the
 * previous default (`1:N`, no flip).
 */
function planRelationship(grain: Grain): { cardinality: Cardinality; flip: boolean } {
  switch (grain) {
    case "1:1":
      return { cardinality: "1:1", flip: false };
    case "N:1":
      return { cardinality: "1:N", flip: true };
    case "N:M":
      return { cardinality: "N:M", flip: false };
    case "1:N":
    case "unknown":
    default:
      return { cardinality: "1:N", flip: false };
  }
}

/**
 * Build the validated action batch that realizes a suggestion: build either table from its
 * source if it doesn't exist yet, then add the relationship between the two columns. The
 * actions reference table/field *names*, exactly as `applyActions` expects, so the whole
 * batch is validated and undoable as one step.
 */
export function buildApplyPlan(
  sources: Source[],
  schema: Schema,
  candidate: JoinKeyCandidate,
): ApplyPlan {
  const leftSource = sources.find((source) => source.id === candidate.left.sourceId);
  const rightSource = sources.find((source) => source.id === candidate.right.sourceId);
  if (!leftSource || !rightSource) {
    return { ok: false, error: "Those sources are no longer loaded." };
  }

  const actions: unknown[] = [];
  const builtTables: string[] = [];
  // Names that will exist after this batch (lowercased -> actual), so two freshly-built
  // tables can't collide with each other or with what's already on the canvas.
  const reserved = new Map<string, string>(
    schema.tables.map((table) => [table.name.toLowerCase(), table.name]),
  );

  const resolve = (source: Source, fieldName: string): string => {
    const existing = tableForSource(schema, source, fieldName);
    if (existing) {
      return existing.name;
    }

    const base = tableNameFromFilename(source.name);
    let name = base;
    let index = 2;
    while (reserved.has(name.toLowerCase())) {
      name = `${base}_${index}`;
      index += 1;
    }
    reserved.set(name.toLowerCase(), name);

    actions.push({
      op: "add_table",
      name,
      fields: source.fields.map((field) => ({ name: field.name, type: field.type })),
    });
    builtTables.push(name);
    return name;
  };

  const leftTable = resolve(leftSource, candidate.left.field);
  const rightTable = resolve(rightSource, candidate.right.field);

  const { cardinality, flip } = planRelationship(candidate.grain);
  const left = { table: leftTable, field: candidate.left.field };
  const right = { table: rightTable, field: candidate.right.field };
  const [from, to] = flip ? [right, left] : [left, right];

  actions.push({
    op: "add_relationship",
    from_table: from.table,
    from_field: from.field,
    to_table: to.table,
    to_field: to.field,
    cardinality,
  });

  return { ok: true, actions, builtTables };
}

/* --------------------------------------------------------------------------------------------
 * Primary-key suggestions (SS-9): a column that the *data* shows is unique and non-null is a
 * key candidate. We only surface candidates whose table already exists on the canvas, so the
 * apply is a single `set_pk` through the validated path. Build the table first (e.g. via a join
 * suggestion or "Build table") and the key suggestion appears.
 * ------------------------------------------------------------------------------------------ */

export type KeySuggestion = {
  /** Stable key for React + dedupe. */
  id: string;
  candidate: PrimaryKeyCandidate;
  /** "<sourceName> · <field>" */
  label: string;
  reason: string;
  /** The table name in the current schema where the key would be set. */
  tableName: string;
};

const MAX_KEY_SUGGESTIONS = 6;

/**
 * Surface primary-key candidates for fields already present on the canvas and not yet flagged
 * as PK. Returns view models the panel renders; "Apply" turns one into a `set_pk` action.
 */
export function buildKeySuggestions(sources: Source[], schema: Schema): KeySuggestion[] {
  const candidates = detectPrimaryKeys(sources);
  const suggestions: KeySuggestion[] = [];

  for (const candidate of candidates) {
    const source = sources.find((entry) => entry.id === candidate.sourceId);
    if (!source) {
      continue;
    }

    const table = tableForSource(schema, source, candidate.field);
    if (!table) {
      continue; // table not built yet — nothing to set a key on
    }

    const field = table.fields.find((entry) => fieldNamesEqual(entry.name, candidate.field));
    if (!field || field.pk) {
      continue; // missing or already the primary key
    }

    suggestions.push({
      id: `${candidate.sourceId}:${table.name}:${candidate.field}`,
      candidate,
      label: `${table.name} · ${candidate.field}`,
      reason: candidate.reason,
      tableName: table.name,
    });

    if (suggestions.length >= MAX_KEY_SUGGESTIONS) {
      break;
    }
  }

  return suggestions;
}

/** Build the validated `set_pk` action batch for a key suggestion. */
export function buildSetPkPlan(suggestion: KeySuggestion): { actions: unknown[] } {
  return {
    actions: [
      { op: "set_pk", table: suggestion.tableName, field: suggestion.candidate.field, pk: true },
    ],
  };
}

/* --------------------------------------------------------------------------------------------
 * Column type suggestions (SS-9): the parser infers a type from each source column's values. A
 * field on the canvas whose type disagrees with that inference is a refinement candidate — most
 * commonly an AI- or hand-added field left as the "text" default whose data is actually numeric.
 * Tables built from a source already carry the inferred type, so those never appear here. Applied
 * via `set_type` through the validated path.
 * ------------------------------------------------------------------------------------------ */

export type TypeSuggestion = {
  /** Stable key for React + dedupe. */
  id: string;
  /** "<table> · <field>" */
  label: string;
  tableName: string;
  field: string;
  currentType: string;
  suggestedType: string;
  reason: string;
};

const MAX_TYPE_SUGGESTIONS = 8;

/**
 * Suggest a column type for canvas fields whose current type disagrees with what their source
 * column's values infer. Only fields already present on the canvas are considered.
 */
export function buildTypeSuggestions(sources: Source[], schema: Schema): TypeSuggestion[] {
  const suggestions: TypeSuggestion[] = [];

  for (const source of sources) {
    for (const sourceField of source.fields) {
      const table = tableForSource(schema, source, sourceField.name);
      if (!table) {
        continue;
      }

      const field = table.fields.find((entry) => fieldNamesEqual(entry.name, sourceField.name));
      if (!field || field.type.toLowerCase() === sourceField.type.toLowerCase()) {
        continue; // missing, or already the inferred type
      }

      suggestions.push({
        id: `${source.id}:${table.name}:${sourceField.name}`,
        label: `${table.name} · ${sourceField.name}`,
        tableName: table.name,
        field: sourceField.name,
        currentType: field.type,
        suggestedType: sourceField.type,
        reason: `data looks like ${sourceField.type}, not ${field.type}`,
      });

      if (suggestions.length >= MAX_TYPE_SUGGESTIONS) {
        return suggestions;
      }
    }
  }

  return suggestions;
}

/** Build the validated `set_type` action batch for a type suggestion. */
export function buildSetTypePlan(suggestion: TypeSuggestion): { actions: unknown[] } {
  return {
    actions: [
      {
        op: "set_type",
        table: suggestion.tableName,
        field: suggestion.field,
        type: suggestion.suggestedType,
      },
    ],
  };
}
