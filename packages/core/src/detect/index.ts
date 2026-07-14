import type { Schema } from "../model.js";
import type { FieldStats, Source, SourceField } from "../parse/types.js";
import { collectStats, isNullToken, MAX_SCAN_ROWS } from "../parse/sample.js";

/**
 * Content-aware modeling primitives (GF-9). These are pure, deterministic functions
 * that reason over the *sample values* captured during parsing — not just column
 * names — to propose join keys and flag identifier columns that won't match without
 * normalization (e.g. HRSA's zero-padded "01234" vs OPAIS's "1234").
 *
 * They emit structured findings only; surfacing them as reviewable suggestions and
 * applying them through `applyActions` is the consumer's job (the copilot, GF-6).
 */

export type FieldRef = {
  sourceId: string;
  sourceName: string;
  field: string;
};

export type FormatIssue = "whitespace" | "case_mismatch" | "leading_zeros" | "numeric_vs_text";

export type FormatMismatch = {
  /** Which normalizations are needed before the two columns will match. */
  issues: FormatIssue[];
  /**
   * Marginal shared-value gain per normalizer step, so a consumer can warn *proportionally*:
   * "+3 of 14,000 matches" is a coverage gap, not a formatting problem. Type-only issues
   * (`numeric_vs_text`) carry no count.
   */
  gains: Partial<Record<FormatIssue, number>>;
  /** Human-readable summary, e.g. "strip leading zeros (+39 matches)". */
  note: string;
};

/**
 * Inferred relationship grain between two join columns, derived from how unique each side's
 * values are (its `stats`). `N:1` means many-left to one-right — consumers that can only
 * express `1:N` should flip the relationship direction. `unknown` when either side lacks the
 * statistics to decide (e.g. older sources, or too few rows to trust).
 */
export type Grain = "1:1" | "1:N" | "N:1" | "N:M" | "unknown";

export type JoinKeyCandidate = {
  left: FieldRef;
  right: FieldRef;
  /** Jaccard overlap of raw sample values, [0, 1]. */
  rawOverlap: number;
  /** Jaccard overlap after normalization, [0, 1]. */
  normalizedOverlap: number;
  /** Count of sample values shared after normalization. */
  sharedValues: number;
  /**
   * Share of the LEFT side's distinct values found on the right, [0, 1]. A real foreign key is
   * a *subset* relationship — the child's keys are contained in the parent's while the parent
   * has many more — so high one-way containment with low symmetric Jaccard is exactly the FK
   * shape. `containmentLeft ≈ 1` reads "left ⊆ right ⇒ left is the FK side".
   */
  containmentLeft: number;
  /** Share of the RIGHT side's distinct values found on the left, [0, 1]. */
  containmentRight: number;
  /** True when normalization meaningfully increases the overlap. */
  requiresNormalization: boolean;
  formatMismatch: FormatMismatch | null;
  /**
   * How key-like the FK (more-contained) side is: its distinct values as a share of its own
   * table's rows, [0, 1]. Near 1 for a real key, near 0 for an enum whose values are shared only
   * because its value space is closed. This is what ranks candidates — see `candidateStrength`.
   */
  fkSideKeyness: number;
  /** Relationship grain, judged against the modeled entity when a side keys one (GAP F). */
  grain: Grain;
  /** Modeling decision derived from containment/grain/blanks — see `classifyRelationship`. */
  verdict: RelationshipVerdict;
  /** Human-readable justification for the verdict. */
  verdictReason: string;
};

export type PrimaryKeyCandidate = {
  sourceId: string;
  sourceName: string;
  field: string;
  /** Non-empty rows the verdict is based on. */
  rows: number;
  /** Human-readable justification, e.g. "unique and non-null across 412 rows". */
  reason: string;
};

export type PrimaryKeyOptions = {
  /** Minimum non-empty rows before uniqueness is trustworthy. Default 4. */
  minRows?: number;
};

/** Below this many non-empty rows, uniqueness is too noisy to draw grain/PK conclusions from. */
const MIN_STATS_ROWS = 4;

export type DetectOptions = {
  /** Minimum normalized Jaccard overlap to propose a join. Default 0.3. */
  minOverlap?: number;
  /** Minimum number of shared normalized values (Jaccard path only). Default 2. */
  minSharedValues?: number;
  /** Minimum one-way containment for the FK-shaped path. Default 0.4. */
  minContainment?: number;
};

const DEFAULT_MIN_OVERLAP = 0.3;
const DEFAULT_MIN_SHARED = 2;
/**
 * Containment gate for the FK-shaped path. Deliberately below 0.5: the flagship real-world
 * bridge (OPAIS npiNumbers → HRSA site NPI) sits near ~53% full-file containment and sampling
 * only ever lowers the observed figure, so a 0.5 gate would suppress the exact FK the
 * containment path exists to surface. `probe_join` is the escape hatch for anything below.
 */
const DEFAULT_MIN_CONTAINMENT = 0.4;
const NORMALIZATION_EPSILON = 0.05;

function stripLeadingZeros(value: string): string {
  return /^\d+$/.test(value) ? value.replace(/^0+(?=\d)/, "") : value;
}

const NORMALIZERS = {
  raw: (value: string) => value,
  trim: (value: string) => value.trim(),
  lower: (value: string) => value.trim().toLowerCase(),
  full: (value: string) => stripLeadingZeros(value.trim().toLowerCase()),
} as const;

type NormalizerKey = keyof typeof NORMALIZERS;

/**
 * The values a field is compared by: the full distinct set captured at parse time, falling back
 * to the 5-value display samples for sources persisted before `distinctValues` existed.
 */
function fieldValues(field: SourceField): string[] {
  return field.distinctValues ?? field.samples;
}

/**
 * The values join/containment detection compares: the wide join-discovery set when the upload
 * session captured one (up to MAX_JOIN_VALUES distinct values over the whole file), else the
 * ≤1000-value scan window. After a reload `joinValues` is gone (stripped from persistence), so
 * detection degrades to the capped set until the file is re-uploaded.
 */
function joinFieldValues(field: SourceField): string[] {
  return field.joinValues ?? field.distinctValues ?? field.samples;
}

function valueSet(field: SourceField, normalize: (value: string) => string): Set<string> {
  const set = new Set<string>();
  for (const sample of joinFieldValues(field)) {
    const normalized = normalize(sample);
    if (normalized !== "") {
      set.add(normalized);
    }
  }
  return set;
}

function intersectionSize(a: Set<string>, b: Set<string>): number {
  // Iterate the smaller set for a stable, order-independent count.
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  let shared = 0;
  for (const value of small) {
    if (large.has(value)) {
      shared += 1;
    }
  }
  return shared;
}

function jaccard(a: Set<string>, b: Set<string>): number {
  const shared = intersectionSize(a, b);
  const union = a.size + b.size - shared;
  return union === 0 ? 0 : shared / union;
}

function overlapAt(left: SourceField, right: SourceField, key: NormalizerKey): number {
  return intersectionSize(valueSet(left, NORMALIZERS[key]), valueSet(right, NORMALIZERS[key]));
}

const ISSUE_NOTES: Record<FormatIssue, string> = {
  whitespace: "trim surrounding whitespace",
  case_mismatch: "normalize letter case",
  leading_zeros: "strip leading zeros",
  numeric_vs_text: "reconcile numeric vs text types",
};

function isNumericType(field: SourceField): boolean {
  return field.type === "int" || field.type === "numeric";
}

/**
 * Compare two fields' sample values and report which normalization steps are needed
 * before they will join. Returns null when the columns match as-is (or don't overlap
 * even after normalization).
 */
export function detectFormatMismatch(left: SourceField, right: SourceField): FormatMismatch | null {
  const raw = overlapAt(left, right, "raw");
  const trimmed = overlapAt(left, right, "trim");
  const lowered = overlapAt(left, right, "lower");
  const full = overlapAt(left, right, "full");

  // No common values even after normalization — not a format problem, just unrelated.
  if (full === 0) {
    return null;
  }

  const issues: FormatIssue[] = [];
  const gains: Partial<Record<FormatIssue, number>> = {};
  if (trimmed > raw) {
    issues.push("whitespace");
    gains.whitespace = trimmed - raw;
  }
  if (lowered > trimmed) {
    issues.push("case_mismatch");
    gains.case_mismatch = lowered - trimmed;
  }
  if (full > lowered) {
    issues.push("leading_zeros");
    gains.leading_zeros = full - lowered;
  }
  if (isNumericType(left) !== isNumericType(right)) {
    issues.push("numeric_vs_text");
  }

  if (issues.length === 0) {
    return null;
  }

  return {
    issues,
    gains,
    note: issues
      .map((issue) => {
        const gained = gains[issue];
        return gained === undefined
          ? ISSUE_NOTES[issue]
          : `${ISSUE_NOTES[issue]} (+${gained} match${gained === 1 ? "" : "es"})`;
      })
      .join("; "),
  };
}

type KeyRole = "unique" | "duplicated" | "unknown";

/**
 * Is this column's join key unique within its own table? Decided from `stats`: a column whose
 * distinct count equals its non-empty count holds no duplicates (key-like); fewer distinct than
 * non-empty means repeats (a "many" side). Without stats, or with too few rows, we can't tell.
 */
function keyRole(field: SourceField): KeyRole {
  const stats = field.stats;
  if (!stats || stats.nonEmpty < MIN_STATS_ROWS) {
    return "unknown";
  }
  return stats.distinct === stats.nonEmpty ? "unique" : "duplicated";
}

/**
 * Overrides for grain inference (GAP F): grain must be judged against the *modeled entity*, not
 * the flat source column. In a denormalized export an org key repeats once per site, so its raw
 * stats read "duplicated" and every join against it mislabels as N:M — even though after the
 * org/site split the column is a unique PK and the real grain is 1:N. A side flagged here is
 * treated as the "one" side regardless of how often its value repeats in the flat file.
 */
export type GrainKeyContext = {
  /** Treat the left column as a modeled-entity key (detected PK, FD determinant, or canvas PK). */
  leftIsEntityKey?: boolean;
  /** Treat the right column as a modeled-entity key. */
  rightIsEntityKey?: boolean;
};

/**
 * Infer the grain of a join between two columns from each side's uniqueness. A unique side is
 * the "one"; a side with duplicates is the "many". `keyContext` marks columns that key a modeled
 * entity — they resolve to "one" even when the denormalized source repeats them (GAP F).
 *
 * The override is *conditional*, because entity-key evidence is weaker than raw uniqueness:
 *
 * - A side that is genuinely unique in its own file already IS the parent, so the other side is
 *   never promoted against it. Without this, the near-universal `customers.customer_id` (PK) /
 *   `orders.customer_id` (FK) convention promotes the child's repeating FK column — a canvas PK
 *   is matched by name — and an N:1 reads as 1:1.
 * - When BOTH sides key an entity and both repeat, neither is the parent: they key the *same*
 *   entity (a shared dimension denormalized into two files). Promoting both would read 1:1;
 *   promoting neither leaves the honest N:M, which `classifyRelationship` turns into the
 *   `shared_parent` verdict — extract the entity, FK both sides into it.
 */
export function inferGrain(
  left: SourceField,
  right: SourceField,
  keyContext?: GrainKeyContext,
): Grain {
  const rawLeft = keyRole(left);
  const rawRight = keyRole(right);
  const promoteLeft = keyContext?.leftIsEntityKey === true && rawRight !== "unique";
  const promoteRight = keyContext?.rightIsEntityKey === true && rawLeft !== "unique";
  // Both promotable ⇒ both repeat and both key an entity ⇒ shared dimension: promote neither.
  const sharedEntity = promoteLeft && promoteRight;

  const leftRole = promoteLeft && !sharedEntity ? "unique" : rawLeft;
  const rightRole = promoteRight && !sharedEntity ? "unique" : rawRight;

  if (leftRole === "unknown" || rightRole === "unknown") {
    return "unknown";
  }
  if (leftRole === "unique" && rightRole === "unique") {
    return "1:1";
  }
  if (leftRole === "unique" && rightRole === "duplicated") {
    return "1:N";
  }
  if (leftRole === "duplicated" && rightRole === "unique") {
    return "N:1";
  }
  return "N:M";
}

const PK_NAME_RANK: Array<{ test: (name: string) => boolean; rank: number }> = [
  { test: (name) => name === "id", rank: 0 },
  { test: (name) => name.endsWith("_id") || name.endsWith("id"), rank: 1 },
  { test: (name) => /(^|_)(code|key|number|uuid|guid)($|_)/.test(name), rank: 2 },
];

/** Lower rank = more likely to be the intended key; pure ordering hint, not a candidacy gate. */
function pkNameRank(name: string): number {
  const lower = name.toLowerCase();
  for (const { test, rank } of PK_NAME_RANK) {
    if (test(lower)) {
      return rank;
    }
  }
  return 3;
}

/**
 * Propose primary keys from the *data*: a column that is unique and non-null across the scanned
 * rows is a key candidate. Candidacy is purely content-driven (uniqueness + no blanks); column
 * names only influence ordering so obvious ids surface first. Deterministically sorted.
 */
export function detectPrimaryKeys(
  sources: Source[],
  options?: PrimaryKeyOptions,
): PrimaryKeyCandidate[] {
  const minRows = options?.minRows ?? MIN_STATS_ROWS;
  const candidates: PrimaryKeyCandidate[] = [];

  for (const source of sources) {
    for (const field of source.fields) {
      // A synthetic surrogate (`_rowId`) is trivially unique and name-ranks above real keys —
      // it must never be presented as a source's primary-key candidate.
      if (field.synthetic) {
        continue;
      }
      const stats = field.stats;
      if (!stats || stats.nonEmpty < minRows || stats.blank > 0) {
        continue;
      }
      if (stats.distinct !== stats.nonEmpty) {
        continue;
      }

      candidates.push({
        sourceId: source.id,
        sourceName: source.name,
        field: field.name,
        rows: stats.nonEmpty,
        reason: `unique and non-null across ${stats.nonEmpty} rows`,
      });
    }
  }

  candidates.sort(
    (a, b) =>
      pkNameRank(a.field) - pkNameRank(b.field) ||
      a.sourceName.localeCompare(b.sourceName) ||
      a.field.localeCompare(b.field),
  );

  return candidates;
}

export type ValueSetSuggestion = "enum" | "lookup";

export type ValueSetCandidate = {
  sourceId: string;
  sourceName: string;
  field: string;
  /** Distinct non-empty values over the scanned rows. */
  distinct: number;
  /** Non-empty rows the ratio is based on. */
  nonEmpty: number;
  /** The full distinct value set (bounded by the low-cardinality gate itself). */
  values: string[];
  /**
   * Ordering hint only, never a verdict: "lookup" when the values read like entity names that
   * could carry attributes of their own, "enum" for short code-like sets. The copilot decides
   * per the design doctrine (lookup table only when it carries attributes or needs integrity).
   */
  suggestion: ValueSetSuggestion;
};

export type ValueSetOptions = {
  /** Maximum distinct values for a field to count as a closed value set. Default 12. */
  maxDistinct?: number;
  /** Maximum distinct/nonEmpty ratio — values must actually repeat. Default 0.5. */
  maxRatio?: number;
  /** Minimum non-empty rows before repetition is trustworthy. Default 4. */
  minRows?: number;
};

const DEFAULT_MAX_DISTINCT = 12;
const DEFAULT_MAX_RATIO = 0.5;

/** Values that read like names/labels (spaces, longer text) hint "lookup"; short codes hint "enum". */
function suggestValueSetKind(values: string[]): ValueSetSuggestion {
  const descriptive = values.filter((value) => value.length > 12 || value.includes(" ")).length;
  return descriptive * 2 > values.length ? "lookup" : "enum";
}

/**
 * Detect closed value sets: columns whose few distinct values repeat across many rows
 * (status, category, country). These are the copilot's evidence for enum-vs-lookup-table
 * normalization decisions. Booleans are excluded — a true/false column is already modeled
 * by its type. Deterministically sorted (fewest distinct values first — the strongest sets).
 */
export function detectValueSets(sources: Source[], options?: ValueSetOptions): ValueSetCandidate[] {
  const maxDistinct = options?.maxDistinct ?? DEFAULT_MAX_DISTINCT;
  const maxRatio = options?.maxRatio ?? DEFAULT_MAX_RATIO;
  const minRows = options?.minRows ?? MIN_STATS_ROWS;

  const candidates: ValueSetCandidate[] = [];

  for (const source of sources) {
    for (const field of source.fields) {
      const stats = field.stats;
      if (field.synthetic || field.type === "bool" || !stats || stats.nonEmpty < minRows) {
        continue;
      }
      if (stats.distinct > maxDistinct || stats.distinct / stats.nonEmpty > maxRatio) {
        continue;
      }

      const values = (field.distinctValues ?? field.samples).filter((value) => value !== "");
      if (values.length === 0) {
        continue;
      }

      candidates.push({
        sourceId: source.id,
        sourceName: source.name,
        field: field.name,
        distinct: stats.distinct,
        nonEmpty: stats.nonEmpty,
        values: [...values].sort((a, b) => a.localeCompare(b)),
        suggestion: suggestValueSetKind(values),
      });
    }
  }

  candidates.sort(
    (a, b) =>
      a.distinct - b.distinct ||
      a.sourceName.localeCompare(b.sourceName) ||
      a.field.localeCompare(b.field),
  );

  return candidates;
}

type TupleColumnView = {
  name: string;
  /** Parser-injected surrogate — never key/FD evidence. */
  synthetic: boolean;
  /** The column's cell per sampled row, aligned with every other view's `values`. */
  values: string[];
  /** Sample-window stats over `values` (null-token-aware, via the shared helper). */
  stats: FieldStats;
  /** distinct/rows over the sample — lower means the column genuinely repeats. */
  distinctRatio: number;
  /** Full-scan-window repeat verdict; true when no stats exist (sample-only evidence). */
  windowDuplicated: boolean;
  /** Full-scan-window non-null verdict; true when no stats exist. */
  windowBlankFree: boolean;
};

/**
 * Per-column view over a source's sampled row tuples. Shared by the composite-key and
 * functional-dependency detectors so their eligibility rules read the same evidence —
 * each composes its own gates from these fields rather than re-deriving them.
 */
function tupleColumnViews(source: Source, rows: string[][]): TupleColumnView[] {
  return source.fields.map((field, index) => {
    const values = rows.map((row) => row[index] ?? "");
    const stats = collectStats(values);
    return {
      name: field.name,
      synthetic: field.synthetic === true,
      values,
      stats,
      distinctRatio: stats.distinct / rows.length,
      windowDuplicated: field.stats ? keyRole(field) === "duplicated" : true,
      windowBlankFree: field.stats ? field.stats.blank === 0 : true,
    };
  });
}

export type CompositeKeyCandidate = {
  sourceId: string;
  sourceName: string;
  /** The two columns that are unique together (neither is unique alone). */
  fields: [string, string];
  /** Sampled row tuples the verdict is based on. */
  rows: number;
  /** Human-readable justification. */
  reason: string;
};

export type CompositeKeyOptions = {
  /** Minimum sampled rows before pair uniqueness is trustworthy. Default 20. */
  minRows?: number;
  /** Maximum candidates reported per source. Default 3. */
  maxPerSource?: number;
};

const MIN_TUPLE_ROWS = 20;
const MAX_COMPOSITE_PER_SOURCE = 3;

/** Joins two cell values into a collision-safe compound key (NUL never appears in data). */
function tupleKey(a: string, b: string): string {
  return `${a}\u0000${b}`;
}

/**
 * Propose composite primary keys from the sampled row tuples: a pair of columns that is unique
 * *together* while neither is unique alone (e.g. `(order_id, line_no)` in an order-lines file).
 * Column-level value sets cannot see this — it needs co-occurring values from the same row,
 * which is exactly what `Source.sampleRows` retains.
 *
 * Uniqueness over a ~200-row sample is weaker evidence than the full scan window, so candidates
 * are ranked (most-repetitive columns first — pairs involving a nearly-unique column are usually
 * coincidental) and capped per source; the `rows` count travels with each so consumers can
 * weigh the evidence. Sources without `sampleRows` (old persistence, multi-sheet XLSX) yield none.
 */
export function detectCompositeKeys(
  sources: Source[],
  options?: CompositeKeyOptions,
): CompositeKeyCandidate[] {
  const minRows = options?.minRows ?? MIN_TUPLE_ROWS;
  const maxPerSource = options?.maxPerSource ?? MAX_COMPOSITE_PER_SOURCE;

  const candidates: CompositeKeyCandidate[] = [];

  for (const source of sources) {
    const rows = source.sampleRows;
    if (!rows || rows.length < minRows) {
      continue;
    }

    // A key column must be non-null, and a composite *member* must repeat BOTH in the
    // tuple sample AND in the full scan window (when stats exist). Pair uniqueness is
    // judged over the sample, so a column that is unique within the sample would make
    // any pair containing it trivially "unique together" — requiring in-sample repeats
    // keeps the two verdicts on the same window. The full-window check additionally
    // rejects columns that are near-unique overall.
    const columns = tupleColumnViews(source, rows).map((column) => ({
      ...column,
      eligible:
        !column.synthetic &&
        column.stats.blank === 0 &&
        column.stats.distinct < column.stats.nonEmpty &&
        column.windowBlankFree &&
        column.windowDuplicated,
    }));

    const sourceCandidates: Array<CompositeKeyCandidate & { score: number }> = [];

    for (let i = 0; i < columns.length; i += 1) {
      for (let j = i + 1; j < columns.length; j += 1) {
        const left = columns[i];
        const right = columns[j];
        if (!left?.eligible || !right?.eligible) {
          continue;
        }

        const combined = new Set<string>();
        for (let row = 0; row < rows.length; row += 1) {
          combined.add(tupleKey(left.values[row] ?? "", right.values[row] ?? ""));
        }
        if (combined.size !== rows.length) {
          continue;
        }

        sourceCandidates.push({
          sourceId: source.id,
          sourceName: source.name,
          fields: [left.name, right.name],
          rows: rows.length,
          reason: `unique together across ${rows.length} sampled rows; neither column is unique alone`,
          // Lower = both columns genuinely repeat — the strongest composite evidence.
          score: left.distinctRatio + right.distinctRatio,
        });
      }
    }

    sourceCandidates.sort(
      (a, b) =>
        a.score - b.score ||
        a.fields[0].localeCompare(b.fields[0]) ||
        a.fields[1].localeCompare(b.fields[1]),
    );
    for (const scored of sourceCandidates.slice(0, maxPerSource)) {
      candidates.push({
        sourceId: scored.sourceId,
        sourceName: scored.sourceName,
        fields: scored.fields,
        rows: scored.rows,
        reason: scored.reason,
      });
    }
  }

  return candidates;
}

export type FunctionalDependencyCandidate = {
  sourceId: string;
  sourceName: string;
  /** The column whose value fixes every dependent's value. */
  determinant: string;
  /** Columns fully determined by the determinant, in source column order. */
  dependents: string[];
  /** Sampled row tuples the verdict is based on. */
  rows: number;
  /** Distinct determinant values in the sample — the would-be extracted table's row count. */
  groups: number;
  /** Human-readable justification. */
  reason: string;
};

export type FunctionalDependencyOptions = {
  /** Minimum sampled rows before dependencies are trustworthy. Default 20. */
  minRows?: number;
  /** Maximum candidates reported per source. Default 3. */
  maxPerSource?: number;
};

const MAX_FDS_PER_SOURCE = 3;
/**
 * Maximum share of blank cells for a column to qualify as an FD dependent. Blank dependent
 * cells are skipped in the holds-check (dirty exports shouldn't hide a real dependency), so
 * without this gate a mostly-blank column with one stray value per group would trivially
 * "hold" and read as an extraction candidate.
 */
const MAX_DEPENDENT_BLANK_RATIO = 0.2;

/**
 * Detect functional dependencies from the sampled row tuples: a column A such that every
 * distinct value of A co-occurs with exactly one value of B (and C, …) across the sample —
 * e.g. `customer_id` determining `customer_name` and `customer_email` in an orders export.
 * This is the hard evidence for a normalization split: the determinant plus its dependents
 * are an extraction candidate for a table of their own, keyed by the determinant.
 *
 * Trivial dependencies are excluded: the determinant must repeat (a unique column determines
 * everything) — both in the sample and, when full-window stats exist, in the scan window —
 * and a dependent must vary (a constant column is determined by anything). Blank dependent
 * cells are skipped rather than treated as conflicting values, so occasional missing data
 * doesn't hide a real dependency; a mostly-blank column can't qualify as a dependent at all
 * (MAX_DEPENDENT_BLANK_RATIO). Like the composite-key detector, sample-window evidence is
 * weaker than a full scan, so candidates are ranked (most dependents first, then the
 * most-repetitive determinant) and capped per source; sources without `sampleRows` yield none.
 */
export function detectFunctionalDependencies(
  sources: Source[],
  options?: FunctionalDependencyOptions,
): FunctionalDependencyCandidate[] {
  const minRows = options?.minRows ?? MIN_TUPLE_ROWS;
  const maxPerSource = options?.maxPerSource ?? MAX_FDS_PER_SOURCE;

  const candidates: FunctionalDependencyCandidate[] = [];

  for (const source of sources) {
    const rows = source.sampleRows;
    if (!rows || rows.length < minRows) {
      continue;
    }

    const columns = tupleColumnViews(source, rows).map((column) => ({
      ...column,
      // A determinant must actually group rows: non-blank, repeating in the sample, and not
      // near-unique over the full scan window (same reasoning as the composite-key gate).
      canDetermine:
        !column.synthetic &&
        column.stats.blank === 0 &&
        column.stats.distinct < column.stats.nonEmpty &&
        column.windowDuplicated,
      // A dependent must vary (a constant column is trivially determined by anything) and be
      // populated enough that skipping its blank cells still leaves real evidence.
      canDepend:
        !column.synthetic &&
        column.stats.distinct > 1 &&
        column.stats.blank <= rows.length * MAX_DEPENDENT_BLANK_RATIO,
    }));

    const sourceCandidates: Array<FunctionalDependencyCandidate & { score: number }> = [];

    for (const determinant of columns) {
      if (!determinant.canDetermine) {
        continue;
      }

      const dependents: string[] = [];
      for (const dependent of columns) {
        if (dependent === determinant || !dependent.canDepend) {
          continue;
        }

        const valueByGroup = new Map<string, string>();
        let holds = true;
        for (let row = 0; row < rows.length; row += 1) {
          const key = determinant.values[row] ?? "";
          const value = dependent.values[row] ?? "";
          // A blank cell is missing data, not a conflicting value — dirty exports shouldn't
          // hide a real dependency. Coverage is enforced by the canDepend gate above.
          if (isNullToken(value)) {
            continue;
          }
          const seen = valueByGroup.get(key);
          if (seen === undefined) {
            valueByGroup.set(key, value);
          } else if (seen !== value) {
            holds = false;
            break;
          }
        }
        if (holds) {
          dependents.push(dependent.name);
        }
      }

      if (dependents.length === 0) {
        continue;
      }

      // canDetermine requires zero blanks, so the sample-window distinct count IS the
      // number of determinant groups — no need to rescan the rows.
      const groups = determinant.stats.distinct;
      sourceCandidates.push({
        sourceId: source.id,
        sourceName: source.name,
        determinant: determinant.name,
        dependents,
        rows: rows.length,
        groups,
        reason: `${determinant.name} determines ${dependents.join(", ")} across ${rows.length} sampled rows (${groups} distinct values) — extraction candidate`,
        // More dependents = a stronger extraction; ties broken toward the most-repetitive
        // determinant (near-unique determinants are usually coincidental).
        score: -dependents.length + determinant.distinctRatio,
      });
    }

    sourceCandidates.sort(
      (a, b) => a.score - b.score || a.determinant.localeCompare(b.determinant),
    );
    for (const scored of sourceCandidates.slice(0, maxPerSource)) {
      candidates.push({
        sourceId: scored.sourceId,
        sourceName: scored.sourceName,
        determinant: scored.determinant,
        dependents: scored.dependents,
        rows: scored.rows,
        groups: scored.groups,
        reason: scored.reason,
      });
    }
  }

  return candidates;
}

export type SemanticType =
  | "email"
  | "url"
  | "uuid"
  | "phone"
  | "timestamp"
  | "currency_amount"
  | "postal_code"
  | "latitude"
  | "longitude"
  // Geographic place/administrative columns. They are attributes of a row, never links between
  // files: two health-center exports share ~4,000 city names and all 50 state codes, and those
  // overlaps say nothing about how the files relate. Naming them lets the join ranking sink them
  // (`NON_KEY_SEMANTICS`) instead of letting them crowd real FKs out of the top-N.
  | "city"
  | "region"
  | "country"
  | "geo_code";

export type SemanticTypeFinding = {
  sourceId: string;
  sourceName: string;
  field: string;
  semantic: SemanticType;
  /** Share of non-empty scanned values matching the pattern, [0, 1]. */
  matchRate: number;
};

export type SemanticTypeOptions = {
  /** Minimum share of values that must match. Default 0.9. */
  minMatchRate?: number;
  /** Minimum non-empty values before a verdict. Default 3. */
  minValues?: number;
};

const DEFAULT_MIN_MATCH_RATE = 0.9;
const DEFAULT_MIN_SEMANTIC_VALUES = 3;

/** A place name: letters and the punctuation of "St. Louis" / "Winston-Salem" — never digits. */
function isPlaceName(value: string): boolean {
  const trimmed = value.trim();
  return trimmed.length > 0 && trimmed.length <= 60 && /^[\p{L}][\p{L} .'-]*$/u.test(trimmed);
}

function isFiniteInRange(value: string, min: number, max: number): boolean {
  if (!/^-?\d+(\.\d+)?$/.test(value.trim())) {
    return false;
  }
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= min && parsed <= max;
}

/**
 * Pattern matchers in priority order — a field gets its first matching semantic. Ambiguous
 * value shapes (5-digit zips vs plain ids, phone-like digit runs, coordinates) additionally
 * require a corroborating column name so plain identifiers don't get misclassified.
 */
const SEMANTIC_MATCHERS: Array<{
  semantic: SemanticType;
  nameHint?: RegExp;
  test: (value: string) => boolean;
}> = [
  {
    semantic: "uuid",
    test: (value) =>
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value.trim()),
  },
  {
    semantic: "email",
    test: (value) => /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(value.trim()),
  },
  {
    semantic: "url",
    test: (value) => /^https?:\/\/\S+$/i.test(value.trim()),
  },
  {
    semantic: "timestamp",
    test: (value) => /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}/.test(value.trim()),
  },
  {
    semantic: "currency_amount",
    test: (value) => /^-?[$€£]\s?\d[\d,]*(\.\d+)?$/.test(value.trim()),
  },
  {
    semantic: "latitude",
    nameHint: /(^|_)lat(itude)?($|_)/i,
    test: (value) => isFiniteInRange(value, -90, 90),
  },
  {
    semantic: "longitude",
    nameHint: /(^|_)(lon|lng|long(itude)?)($|_)/i,
    test: (value) => isFiniteInRange(value, -180, 180),
  },
  {
    // 4 digits covers the bare ZIP+4 extension, which real exports carry as its own `zip4`
    // column. Without it the column misses this matcher, reads as a high-cardinality numeric
    // key, and its coincidental collisions with `pharmacyId`/`contractId` take findings slots.
    // Safe because the name hint gates it: a plain id column is never called "zip" or "postal".
    semantic: "postal_code",
    nameHint: /zip|postal/i,
    test: (value) => /^\d{4,5}(-\d{4})?$/.test(value.trim()),
  },
  {
    // The ≥7-digit floor is what stops a bare digit run from reading as a phone number, but a
    // phone *extension* is 2-5 digits and would fail it — leaving `phoneNumberExtension` to read
    // as a high-cardinality numeric key that collides with zip4/pharmacyId. The name hint already
    // establishes it is telephony, so a short digit run is admitted only when the name says so.
    semantic: "phone",
    nameHint: /phone|mobile|tel|fax/i,
    test: (value) => {
      const trimmed = value.trim();
      if (!/^\+?[0-9()\s.-]{1,20}$/.test(trimmed)) {
        return false;
      }
      const digits = trimmed.match(/\d/g)?.length ?? 0;
      // A full number (≥7 digits), or a short extension (a handful of digits, nothing else).
      return digits >= 7 || (digits >= 1 && trimmed.length <= 6);
    },
  },
  // A place NAME: letters, spaces and the punctuation of "St. Louis" / "Winston-Salem". The
  // alphabetic test is what keeps these from swallowing codes — "State and County FIPS Code"
  // matches the `region` name hint but holds digits, so it falls through to `geo_code` below.
  {
    semantic: "city",
    nameHint: /\b(city|town|municipality)\b/i,
    test: isPlaceName,
  },
  {
    semantic: "region",
    nameHint: /\b(state|province|region|county)\b/i,
    test: isPlaceName,
  },
  {
    semantic: "country",
    nameHint: /\b(country|nation)\b/i,
    test: isPlaceName,
  },
  // A numeric administrative code (FIPS, census tract, congressional district). These collide
  // with real numeric ids by pure coincidence — on the real HRSA/OPAIS pair a FIPS+district code
  // matched `zip4`, `pharmacyId` and `contractId` well enough to take most of the findings window.
  {
    semantic: "geo_code",
    nameHint: /\b(fips|census|tract|congressional district)\b|federal information processing/i,
    test: (value) => /^\d{1,11}$/.test(value.trim()),
  },
];

/**
 * Classify columns by what their values *are* (emails, URLs, coordinates, timestamps…), not just
 * their storage type. These findings let the copilot propose richer target types — e.g. paired
 * latitude/longitude columns become a PostGIS `geography(Point, 4326)` suggestion. Deterministic
 * and sorted (sourceName, field).
 */
export function detectSemanticTypes(
  sources: Source[],
  options?: SemanticTypeOptions,
): SemanticTypeFinding[] {
  const minMatchRate = options?.minMatchRate ?? DEFAULT_MIN_MATCH_RATE;
  const minValues = options?.minValues ?? DEFAULT_MIN_SEMANTIC_VALUES;

  const findings: SemanticTypeFinding[] = [];

  for (const source of sources) {
    for (const field of source.fields) {
      if (field.synthetic) {
        continue;
      }
      const values = fieldValues(field).filter((value) => value.trim() !== "");
      if (values.length < minValues) {
        continue;
      }

      for (const matcher of SEMANTIC_MATCHERS) {
        if (matcher.nameHint && !matcher.nameHint.test(field.name)) {
          continue;
        }
        const matched = values.filter(matcher.test).length;
        const matchRate = matched / values.length;
        if (matchRate >= minMatchRate) {
          findings.push({
            sourceId: source.id,
            sourceName: source.name,
            field: field.name,
            semantic: matcher.semantic,
            matchRate,
          });
          break;
        }
      }
    }
  }

  findings.sort(
    (a, b) => a.sourceName.localeCompare(b.sourceName) || a.field.localeCompare(b.field),
  );

  return findings;
}

export type RelationshipVerdict =
  | "enforced_fk"
  | "nullable_fk"
  | "not_valid_fk"
  | "junction"
  | "shared_parent"
  | "no_link";

export type RelationshipClassification = {
  verdict: RelationshipVerdict;
  /** Human-readable justification, phrased as a modeling instruction. */
  reason: string;
};

export type ClassifyRelationshipInput = {
  containmentLeft: number;
  containmentRight: number;
  grain: Grain;
  /**
   * Blank share of the FK-side (more-contained) column, [0, 1]. `undefined` means *unverified*
   * — no stats, or a blank count measured over a scan window narrower than the file. It is not
   * the same as zero: only a verified zero can certify an enforceable (NOT NULL) FK.
   */
  nullRate?: number | undefined;
  formatMismatch?: FormatMismatch | null | undefined;
  /**
   * True when both sides key a modeled entity and both repeat — they key the *same* entity,
   * denormalized into two files. Yields `shared_parent` rather than `junction`.
   */
  bothSidesKeyEntity?: boolean | undefined;
  /**
   * The containment gate below which a pair is too weak for FK semantics. Must be the SAME
   * value the caller admitted the candidate with (`DetectOptions.minContainment`), or the
   * classifier condemns pairs the detector deliberately let through.
   */
  minContainment?: number | undefined;
};

/** Below this max containment the key spaces are effectively disjoint — no relationship. */
const NO_LINK_MAX_CONTAINMENT = 0.05;
/** At/above this every FK-side key resolves (within rounding) — the FK is enforceable. */
const ENFORCEABLE_MIN_CONTAINMENT = 0.999;

/**
 * Turn raw join evidence into a consistent modeling decision (GAP G). Enforceability and
 * representation are separate concerns: a relationship supported by the data is *represented*
 * even when partial coverage means it cannot be *enforced* — that is a nullable/soft FK (or a
 * junction for N:M), never a dropped edge. Only a near-zero-containment pair is "no link".
 * Pure and deterministic; consumed by `detectJoinKeys`, `probeJoin`, and the copilot prompt.
 */
export function classifyRelationship(input: ClassifyRelationshipInput): RelationshipClassification {
  const { containmentLeft, containmentRight, grain } = input;
  const coverage = Math.max(containmentLeft, containmentRight);
  const fkSide = containmentLeft >= containmentRight ? "left" : "right";
  const pct = Math.round(coverage * 100);
  const minContainment = input.minContainment ?? DEFAULT_MIN_CONTAINMENT;
  const normalizeNote = input.formatMismatch
    ? ` Normalize first: ${input.formatMismatch.note}.`
    : "";

  if (coverage < NO_LINK_MAX_CONTAINMENT) {
    return {
      verdict: "no_link",
      reason: `near-zero containment (${pct}%) — the columns do not share a key space; reject the join regardless of how similar the names look.`,
    };
  }

  if (coverage < minContainment) {
    return {
      verdict: "not_valid_fk",
      reason: `only ${pct}% of the ${fkSide} side's keys resolve — too weak for FK semantics. These figures are already final over the widest captured values; inspect_source the two columns to judge whether the gap is semantic (different populations) or dirty data, then either model a soft link or leave it unlinked and say why.${normalizeNote}`,
    };
  }

  if (grain === "N:M") {
    if (input.bothSidesKeyEntity) {
      return {
        verdict: "shared_parent",
        reason: `both columns key the same entity (each determines its own file's attributes for it) and ${pct}% of the ${fkSide} side's keys resolve — neither file is the parent: extract that entity as its own table keyed by the shared column, or reuse the existing table if one already models it, then give each source a 1:N FK into it. Do NOT draw a direct edge between the two sources, and do NOT add a second table for an entity already on the canvas.${normalizeNote}`,
      };
    }
    return {
      verdict: "junction",
      reason: `both sides repeat and ${pct}% of the ${fkSide} side's keys resolve — model with a junction table and two 1:N relationships, never a direct N:M edge.${normalizeNote}`,
    };
  }

  const { nullRate } = input;
  // `nullRate === 0` must be a *verified* zero: `undefined` means unmeasured (no stats, or a
  // blank count from a scan window narrower than the file), and an unmeasured column cannot
  // certify a NOT NULL FK. Likewise an "unknown" grain carries no uniqueness evidence at all.
  if (coverage >= ENFORCEABLE_MIN_CONTAINMENT && nullRate === 0 && grain !== "unknown") {
    return {
      verdict: "enforced_fk",
      reason: `every ${fkSide}-side key resolves to a parent and the column has no blanks (grain ${grain}) — an enforceable FK.${normalizeNote}`,
    };
  }

  const blankNote =
    nullRate === undefined
      ? "; blank rate unverified over the full file"
      : nullRate > 0
        ? `; ${Math.round(nullRate * 100)}% of FK rows are blank`
        : "";
  const grainNote =
    grain === "unknown" ? " (grain unknown — too few rows to judge uniqueness)" : "";
  return {
    verdict: "nullable_fk",
    reason: `partial coverage (${pct}% of the ${fkSide} side's keys resolve${blankNote}, grain ${grain})${grainNote} — still represent the relationship, as a nullable/soft FK; partial coverage limits enforceability, not representation.${normalizeNote}`,
  };
}

/** Compound source/field key for set membership (NUL never appears in names). */
function fieldKey(sourceId: string, field: string): string {
  return `${sourceId}\u0000${field}`;
}

/**
 * Fields that key a *modeled entity* even when they repeat in the flat file (GAP F):
 * functional-dependency determinants, each the would-be primary key of the table its extraction
 * candidate creates. In the flagship HRSA case `Health Center Number` repeats once per site yet
 * determines the org-level columns, so it keys the organization entity.
 *
 * Detected primary keys are deliberately NOT collected: a PK candidate is `distinct === nonEmpty`
 * with no blanks, which is exactly when `keyRole` already returns "unique" — adding them would be
 * a no-op that costs a full `detectPrimaryKeys` pass.
 *
 * A determinant must also look like an *entity key* rather than a lookup/enum, because
 * `detectFunctionalDependencies` has no distinctness floor: a `state` column determining
 * `state_name` is a perfectly good determinant, but promoting it makes an incidental state-code
 * match between two address blocks read as a relationship between the files.
 *
 * An absolute cardinality floor cannot express that distinction — a US-state column has ~50
 * distinct values, as many as a small entity table. The signal is the determinant's *repeat
 * ratio* within its own scan window (`groups / rows`; `nonEmpty === rows` because `canDetermine`
 * requires zero blanks). An entity key is near-unique per row and only repeats because the file
 * is denormalized; an enum repeats because its value space is closed. Measured on the real
 * 18,855-row HRSA export, sampled at `MAX_ROW_TUPLES`:
 *
 *   Health Center Number  167 groups / 200 rows = 0.835   ← entity key
 *   Site State Abbreviation 46 groups / 200 rows = 0.230   ← enum
 *
 * `DEFAULT_MAX_RATIO` (the ceiling `detectValueSets` already uses to call a column a closed value
 * set) separates them. The absolute floor is kept as a guard for small windows, where a couple of
 * repeats can push a tiny value set over the ratio.
 *
 */
function entityKeyFields(sources: Source[], nonKeys: Set<string>): Set<string> {
  const keys = new Set<string>();
  const fieldLookup = new Map<string, SourceField>();
  for (const source of sources) {
    for (const field of source.fields) {
      fieldLookup.set(fieldKey(source.id, field.name), field);
    }
  }

  // Computed uncapped, and deliberately NOT accepted from a caller: `detectFunctionalDependencies`
  // applies a per-source *display* cap (`MAX_FDS_PER_SOURCE = 3`), and on the real HRSA export
  // that cap ranked `Health Center Number` out behind three chattier determinants. Feeding the
  // display list in here would silently starve the org key — the flagship join then grades N:M
  // ("build a junction table") instead of 1:N, which is exactly what GAP F set out to fix.
  const fds = detectFunctionalDependencies(sources, { maxPerSource: Number.POSITIVE_INFINITY });
  for (const candidate of fds) {
    const key = fieldKey(candidate.sourceId, candidate.determinant);
    const repeatRatio = candidate.rows === 0 ? 0 : candidate.groups / candidate.rows;
    if (candidate.groups <= DEFAULT_MAX_DISTINCT || repeatRatio <= DEFAULT_MAX_RATIO) {
      continue;
    }
    // A zip determines its city and state, so it is a textbook determinant — but it keys a value
    // space, not an entity in this schema.
    if (nonKeys.has(key)) {
      continue;
    }
    // A determinant must also be an *identifier*. A near-unique free-text column (an address
    // line, an organization name) determines its row's attributes trivially — but keys nothing.
    const field = fieldLookup.get(key);
    if (field && identifierRatio(field) < IDENTIFIER_MIN_RATIO) {
      continue;
    }
    keys.add(key);
  }
  return keys;
}

/** Loose name equality for matching canvas fields to source columns ("Health Center Number" ↔ "health_center_number"). */
function canonicalFieldName(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/** Canonical names of every field currently marked pk on the canvas. */
function schemaPkNames(schema: Schema): Set<string> {
  const names = new Set<string>();
  for (const table of schema.tables) {
    for (const tableField of table.fields) {
      if (tableField.pk) {
        names.add(canonicalFieldName(tableField.name));
      }
    }
  }
  return names;
}

/**
 * Blank share of a column, [0, 1], or `undefined` when it cannot be verified.
 *
 * `stats` is capped at `MAX_SCAN_ROWS` while containment is computed over the *full-file*
 * `joinValues`, so a zero blank count from a partial window says nothing about the rest of the
 * column: a 50k-row FK fully populated in its first 1000 rows but 30% blank thereafter would
 * otherwise certify as an enforceable NOT NULL FK. A zero is only trustworthy when the window
 * covered every row (`rowCount` is the uncapped count). A *non-zero* rate needs no such proof —
 * blanks seen are blanks — and downgrades the pair to a nullable FK either way.
 */
function blankRate(source: Source, field: SourceField): number | undefined {
  const stats = field.stats;
  if (!stats) {
    return undefined;
  }
  const scanned = stats.nonEmpty + stats.blank;
  if (scanned === 0) {
    return undefined;
  }
  const windowIsWholeFile = source.rowCount !== undefined && scanned >= source.rowCount;
  if (stats.blank === 0 && !windowIsWholeFile) {
    return undefined;
  }
  return stats.blank / scanned;
}

/** Values a join key is made of: no internal whitespace, not prose-length. */
const IDENTIFIER_MAX_LENGTH = 32;
/** How many values to test — identifier-ness is uniform within a column; no need to scan it all. */
const IDENTIFIER_SAMPLE = 200;
/** Below this share of identifier-like values, a column is prose and cannot key an entity. */
const IDENTIFIER_MIN_RATIO = 0.9;

/**
 * Semantic types that are *attributes*, never join keys. A postal code, a phone number, a
 * lat/long or a money amount can overlap heavily across two files — the real OPAIS/HRSA data has
 * ~13,000 shared zips — but that overlap is a property of the value space, not a relationship.
 * Left unfiltered they crowd the FKs out of the consumers' top-N, and a numeric id can even
 * collide with a zip by coincidence (`ceId ↔ shippingAddresses.zip`, 80% containment, meaningless).
 * `uuid`/`email`/`url` are NOT listed: those genuinely serve as natural keys.
 */
const NON_KEY_SEMANTICS: ReadonlySet<SemanticType> = new Set<SemanticType>([
  "postal_code",
  "phone",
  "latitude",
  "longitude",
  "timestamp",
  "currency_amount",
  // Geography is an attribute of a row, not a link between files. Two health-center exports share
  // ~4,000 city names and every state code; ranked on overlap those beat every real FK.
  "city",
  "region",
  "country",
  "geo_code",
]);

/** Fields whose values are an attribute type that cannot be a join key. */
function nonKeyFields(sources: Source[]): Set<string> {
  const fields = new Set<string>();
  for (const finding of detectSemanticTypes(sources)) {
    if (NON_KEY_SEMANTICS.has(finding.semantic)) {
      fields.add(fieldKey(finding.sourceId, finding.field));
    }
  }
  return fields;
}

/**
 * Share of a column's values that look like *identifiers* rather than prose, [0, 1].
 *
 * Cardinality alone cannot tell a key from a description: `Site Name`, `addressLine1` and
 * `subName` are all high-cardinality and overlap heavily across the real files, so a purely
 * cardinality-weighted ranking floats free text to the top exactly where the FKs belong. A key is
 * a code — no spaces, bounded length; a street address or an organization name is neither. Same
 * intuition as `suggestValueSetKind`'s descriptive test, applied to join ranking.
 */
function identifierRatio(field: SourceField): number {
  const values = fieldValues(field);
  const limit = Math.min(values.length, IDENTIFIER_SAMPLE);
  if (limit === 0) {
    return 1;
  }
  let identifierLike = 0;
  for (let i = 0; i < limit; i += 1) {
    const value = values[i] ?? "";
    if (value.length <= IDENTIFIER_MAX_LENGTH && !/\s/.test(value)) {
      identifierLike += 1;
    }
  }
  return identifierLike / limit;
}

/**
 * How key-like a column is: its distinct values as a share of its own table's rows, over the
 * WIDEST captured sets (`joinValues`, not the ≤1000-row `stats` window, which reports a
 * near-unique ratio for any column once the window is smaller than the file).
 *
 * A real key is near-unique across its table and repeats only because the file is denormalized;
 * an enum repeats because its value space is closed. On the real HRSA export: `BPHC Assigned
 * Number` 18855/18855 = 1.0, `Health Center Number` 1527/18855 = 0.081, `Site State Abbreviation`
 * 59/18855 = 0.003. Returns 1 (neutral — never penalize) when the row count is unknown.
 */
function keyness(distinct: number, source: Source, field: SourceField, isNonKey: boolean): number {
  // A postal code / phone / lat-long is an attribute. Its overlap is real but it is not a link,
  // so it sorts below everything with any key-likeness at all (still emitted — `probe_join` and
  // the full candidate list remain the escape hatch).
  if (isNonKey) {
    return 0;
  }
  return cardinalityKeyness(distinct, source, field) * identifierRatio(field);
}

/**
 * Distinct values as a share of the table's rows, measured over the FULL file.
 *
 * Entity-key status deliberately does NOT short-circuit this to 1. Being an FD determinant is
 * evidence about *grain* (GAP F), not about how selective a column is, and granting it free rank
 * is actively harmful: determinant status is decided on a 200-row even sample, where any column
 * with more than ~200 distinct values looks near-unique regardless of what it is. On the real
 * HRSA export that promoted `State FIPS and Congressional District Number Code` (442 values, a
 * geographic code) and floated its numeric collisions with zip4/pharmacyId/contractId into every
 * top-N slot. Judged against the whole file it is 442/18855 = 0.023 and sinks, while the org key
 * (1527/18855 = 0.081) and the NPI column (0.32) stay well clear of the enums (state: 0.003).
 */
function cardinalityKeyness(distinct: number, source: Source, field: SourceField): number {
  const rows = source.rowCount;
  if (rows !== undefined && rows > 0) {
    return Math.min(1, distinct / rows);
  }
  const stats = field.stats;
  if (stats && stats.nonEmpty > 0) {
    return Math.min(1, stats.distinct / stats.nonEmpty);
  }
  return 1;
}

/**
 * Rank a candidate by containment weighted by how key-like its FK side is.
 *
 * Containment alone is the wrong ranking signal, and on the real files it is catastrophically
 * wrong: a 59-value `state ↔ state` match has 100% containment both ways, while the flagship NPI
 * bridge has 53%. Ranked on containment, every one of the 8 slots a consumer shows the model was
 * a state/zip/boolean match — the real bridges ranked #41 (HCN ↔ grantNumber), #60 (BPHC) and #96
 * (NPI) out of 126, so the model never saw a single one and the evidence pipeline was moot.
 *
 * Weighting by the FK side's `keyness` demotes exactly the columns that are shared *because their
 * value space is closed*, without penalizing a high-cardinality bijection: an 18,855-value 1:1 key
 * pair keeps keyness 1.0 and still sorts top, while a 59-value enum collapses to ~0.003.
 *
 * Known trade (unchanged from the admission gate): a genuine FK into a small dimension table has
 * low keyness and sorts low. It is still emitted — `probe_join` remains the escape hatch.
 */
function candidateStrength(candidate: JoinKeyCandidate): number {
  const containment = Math.max(
    candidate.normalizedOverlap,
    candidate.containmentLeft,
    candidate.containmentRight,
  );
  return containment * candidate.fkSideKeyness;
}

function compareRefs(a: FieldRef, b: FieldRef): number {
  return (
    a.sourceId.localeCompare(b.sourceId) ||
    a.sourceName.localeCompare(b.sourceName) ||
    a.field.localeCompare(b.field)
  );
}

/**
 * Propose join keys across sources by sample-value overlap. Compares every pair of
 * fields from *different* sources; a pair is a candidate when its normalized overlap
 * and shared-value count clear the thresholds. Output is sorted deterministically.
 */
export type ProbeJoinRef = { source: string; field: string };

export type ProbeJoinOptions = {
  /**
   * The schema currently on the canvas. A probed column already modeled as (or matching the
   * name of) a table's primary key resolves to the "one" side of the grain regardless of how
   * often the flat source repeats it (GAP F) — turning "N:M at best" into "1:N, nullable FK".
   * The promotion yields to raw uniqueness on the other side, so a child's FK column that shares
   * the parent PK's name (`orders.customer_id`) is not mistaken for the parent.
   */
  schema?: Schema;
};

export type ProbeJoinResult =
  | {
      ok: true;
      /** Distinct normalized values shared by the two columns. */
      shared: number;
      /** Distinct normalized values on each side (over the widest captured set). */
      leftDistinct: number;
      rightDistinct: number;
      /** Jaccard overlap of raw (un-normalized) values, [0, 1]. */
      rawOverlap: number;
      /** Jaccard overlap after normalization, [0, 1]. */
      normalizedOverlap: number;
      /** Share of each side's values found on the other, [0, 1]. High one-way = FK shape. */
      containmentLeft: number;
      containmentRight: number;
      /** Relationship grain, judged against the modeled entity when a side keys one (GAP F). */
      grain: Grain;
      /**
       * True when the side's column keys a modeled entity (detected PK, FD determinant, or a
       * canvas PK when a schema was passed) — its grain reads "one" despite flat-file repeats.
       */
      leftIsEntityKey: boolean;
      rightIsEntityKey: boolean;
      /** Modeling decision derived from containment/grain/blanks — see `classifyRelationship`. */
      verdict: RelationshipVerdict;
      verdictReason: string;
      formatMismatch: FormatMismatch | null;
      /**
       * False when a side lost its wide join set (e.g. after a project reload) and the probe
       * ran over the ≤1000-value scan window — figures are then lower bounds; re-upload the
       * file for full fidelity.
       */
      leftFullFidelity: boolean;
      rightFullFidelity: boolean;
    }
  | { ok: false; error: string };

/** Resolve a probe ref against the loaded sources, reporting valid names on a miss. */
function resolveProbeRef(
  sources: Source[],
  ref: ProbeJoinRef,
): { field: SourceField; source: Source } | { error: string } {
  const source = sources.find((candidate) => candidate.name === ref.source);
  if (!source) {
    const names = sources.map((candidate) => candidate.name).join(", ");
    return { error: `no source named "${ref.source}". Available sources: ${names || "(none)"}.` };
  }
  const field = source.fields.find((candidate) => candidate.name === ref.field);
  if (!field) {
    const names = source.fields.map((candidate) => candidate.name).join(", ");
    return {
      error: `no field named "${ref.field}" in ${source.name}. Available fields: ${names || "(none)"}.`,
    };
  }
  return { field, source };
}

/** Is this field's probe running over the full file, or a capped fallback window? */
function hasFullFidelity(source: Source, field: SourceField): boolean {
  if (field.joinValues) {
    return true;
  }
  // Without a wide set, fidelity holds only when the file never exceeded the scan window —
  // compare against the window itself, not the deduped distinct count, which shrinks with
  // every repeated or blank value.
  return source.rowCount !== undefined && source.rowCount <= MAX_SCAN_ROWS;
}

/**
 * Probe an arbitrary field pair for join evidence, on demand (GF: the copilot's `probe_join`
 * tool). Unlike `detectJoinKeys` — a thresholded global top-N — this computes live overlap,
 * containment, grain, and format-mismatch for exactly the pair the caller hypothesizes, with
 * no admission gate: near-zero figures are the point when rejecting a look-alike join. Pure
 * and read-only, computed over the widest captured value sets (`joinValues ?? distinctValues`).
 */
export function probeJoin(
  sources: Source[],
  input: { left: ProbeJoinRef; right: ProbeJoinRef },
  options?: ProbeJoinOptions,
): ProbeJoinResult {
  const left = resolveProbeRef(sources, input.left);
  if ("error" in left) {
    return { ok: false, error: `left: ${left.error}` };
  }
  const right = resolveProbeRef(sources, input.right);
  if ("error" in right) {
    return { ok: false, error: `right: ${right.error}` };
  }

  const leftRaw = valueSet(left.field, NORMALIZERS.raw);
  const rightRaw = valueSet(right.field, NORMALIZERS.raw);
  const leftFull = valueSet(left.field, NORMALIZERS.full);
  const rightFull = valueSet(right.field, NORMALIZERS.full);
  const shared = intersectionSize(leftFull, rightFull);
  const containmentLeft = leftFull.size === 0 ? 0 : shared / leftFull.size;
  const containmentRight = rightFull.size === 0 ? 0 : shared / rightFull.size;

  // Schema-aware grain (GAP F): a side keying a modeled entity — an FD determinant, or a field
  // already marked pk on the canvas — is the "one" side even when the flat source repeats it.
  // `inferGrain` decides whether the flag actually *fires*: raw uniqueness on the other side
  // outranks it, and two flagged sides mean a shared parent, not a 1:1.
  const nonKeys = nonKeyFields(sources);
  const entityKeys = entityKeyFields(sources, nonKeys);
  const canvasPks = options?.schema ? schemaPkNames(options.schema) : new Set<string>();
  const leftIsEntityKey =
    entityKeys.has(fieldKey(left.source.id, left.field.name)) ||
    canvasPks.has(canonicalFieldName(left.field.name));
  const rightIsEntityKey =
    entityKeys.has(fieldKey(right.source.id, right.field.name)) ||
    canvasPks.has(canonicalFieldName(right.field.name));

  const grain = inferGrain(left.field, right.field, { leftIsEntityKey, rightIsEntityKey });
  const formatMismatch = detectFormatMismatch(left.field, right.field);
  const fkSide = containmentLeft >= containmentRight ? left : right;
  const classification = classifyRelationship({
    containmentLeft,
    containmentRight,
    grain,
    nullRate: blankRate(fkSide.source, fkSide.field),
    formatMismatch,
    // Both flagged AND still N:M ⇒ `inferGrain` promoted neither ⇒ they key the same entity.
    bothSidesKeyEntity: leftIsEntityKey && rightIsEntityKey && grain === "N:M",
  });

  return {
    ok: true,
    shared,
    leftDistinct: leftFull.size,
    rightDistinct: rightFull.size,
    rawOverlap: jaccard(leftRaw, rightRaw),
    normalizedOverlap: jaccard(leftFull, rightFull),
    containmentLeft,
    containmentRight,
    grain,
    leftIsEntityKey,
    rightIsEntityKey,
    verdict: classification.verdict,
    verdictReason: classification.reason,
    formatMismatch,
    leftFullFidelity: hasFullFidelity(left.source, left.field),
    rightFullFidelity: hasFullFidelity(right.source, right.field),
  };
}

export function detectJoinKeys(sources: Source[], options?: DetectOptions): JoinKeyCandidate[] {
  const minOverlap = options?.minOverlap ?? DEFAULT_MIN_OVERLAP;
  const minShared = options?.minSharedValues ?? DEFAULT_MIN_SHARED;
  const minContainment = options?.minContainment ?? DEFAULT_MIN_CONTAINMENT;
  // Modeled-entity keys (GAP F): a join against one of these is graded 1:N rather than N:M even
  // when the denormalized source repeats it — subject to `inferGrain`'s precedence rules.
  const nonKeys = nonKeyFields(sources);
  const entityKeys = entityKeyFields(sources, nonKeys);

  const candidates: JoinKeyCandidate[] = [];

  // Each field's sets are needed once per field on the other side; build them once, not per pair.
  const setsByField = new Map<SourceField, { raw: Set<string>; full: Set<string> }>();
  const setsFor = (field: SourceField): { raw: Set<string>; full: Set<string> } => {
    let sets = setsByField.get(field);
    if (!sets) {
      sets = { raw: valueSet(field, NORMALIZERS.raw), full: valueSet(field, NORMALIZERS.full) };
      setsByField.set(field, sets);
    }
    return sets;
  };

  for (let i = 0; i < sources.length; i += 1) {
    for (let j = i + 1; j < sources.length; j += 1) {
      const leftSource = sources[i];
      const rightSource = sources[j];
      if (!leftSource || !rightSource) {
        continue;
      }

      for (const leftField of leftSource.fields) {
        if (leftField.synthetic) {
          continue;
        }
        for (const rightField of rightSource.fields) {
          if (rightField.synthetic) {
            continue;
          }
          const left = setsFor(leftField);
          const right = setsFor(rightField);
          const rawOverlap = jaccard(left.raw, right.raw);
          const sharedValues = intersectionSize(left.full, right.full);
          const normalizedOverlap = jaccard(left.full, right.full);
          const containmentLeft = left.full.size === 0 ? 0 : sharedValues / left.full.size;
          const containmentRight = right.full.size === 0 ? 0 : sharedValues / right.full.size;

          // Two admission paths. Jaccard catches symmetric overlap; containment catches the
          // FK *subset* shape (child ⊆ large parent) that symmetric Jaccard averages away.
          // The containment path needs its own guard — `minShared` does not stop enums: a
          // 3-value enum fully present in a large column has containment 1.0 and 3 shared
          // values. Only let it fire when the contained (smaller) side is NOT itself a closed
          // value set (more distinct values than the value-set cardinality ceiling). Known
          // trade: a real FK into a ≤12-key dimension must surface via the Jaccard path.
          const jaccardPass = normalizedOverlap >= minOverlap && sharedValues >= minShared;
          const containedSideDistinct =
            containmentLeft >= containmentRight ? left.full.size : right.full.size;
          const containmentPass =
            Math.max(containmentLeft, containmentRight) >= minContainment &&
            containedSideDistinct > DEFAULT_MAX_DISTINCT;
          if (!jaccardPass && !containmentPass) {
            continue;
          }

          const formatMismatch = detectFormatMismatch(leftField, rightField);
          const leftIsEntityKey = entityKeys.has(fieldKey(leftSource.id, leftField.name));
          const rightIsEntityKey = entityKeys.has(fieldKey(rightSource.id, rightField.name));
          const grain = inferGrain(leftField, rightField, { leftIsEntityKey, rightIsEntityKey });
          const fkIsLeft = containmentLeft >= containmentRight;
          const classification = classifyRelationship({
            containmentLeft,
            containmentRight,
            grain,
            nullRate: fkIsLeft
              ? blankRate(leftSource, leftField)
              : blankRate(rightSource, rightField),
            formatMismatch,
            bothSidesKeyEntity: leftIsEntityKey && rightIsEntityKey && grain === "N:M",
            // The classifier must condemn a pair only by the gate that admitted it.
            minContainment,
          });
          // The FK side is the contained one; its key-likeness is what ranks this candidate.
          const fkSideKeyness = fkIsLeft
            ? keyness(
                left.full.size,
                leftSource,
                leftField,
                nonKeys.has(fieldKey(leftSource.id, leftField.name)),
              )
            : keyness(
                right.full.size,
                rightSource,
                rightField,
                nonKeys.has(fieldKey(rightSource.id, rightField.name)),
              );

          candidates.push({
            left: {
              sourceId: leftSource.id,
              sourceName: leftSource.name,
              field: leftField.name,
            },
            right: {
              sourceId: rightSource.id,
              sourceName: rightSource.name,
              field: rightField.name,
            },
            rawOverlap,
            normalizedOverlap,
            sharedValues,
            containmentLeft,
            containmentRight,
            requiresNormalization:
              normalizedOverlap - rawOverlap > NORMALIZATION_EPSILON || formatMismatch !== null,
            formatMismatch,
            fkSideKeyness,
            grain,
            verdict: classification.verdict,
            verdictReason: classification.reason,
          });
        }
      }
    }
  }

  candidates.sort(
    (a, b) =>
      candidateStrength(b) - candidateStrength(a) ||
      b.normalizedOverlap - a.normalizedOverlap ||
      b.sharedValues - a.sharedValues ||
      compareRefs(a.left, b.left) ||
      compareRefs(a.right, b.right),
  );

  return candidates;
}
