import type { Source, SourceField } from "../parse/types.js";

/**
 * Content-aware modeling primitives (SS-9). These are pure, deterministic functions
 * that reason over the *sample values* captured during parsing — not just column
 * names — to propose join keys and flag identifier columns that won't match without
 * normalization (e.g. HRSA's zero-padded "01234" vs OPAIS's "1234").
 *
 * They emit structured findings only; surfacing them as reviewable suggestions and
 * applying them through `applyActions` is the consumer's job (the copilot, SS-6).
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
  /** Human-readable summary, e.g. "strip leading zeros before joining". */
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
  /** True when normalization meaningfully increases the overlap. */
  requiresNormalization: boolean;
  formatMismatch: FormatMismatch | null;
  /** Relationship grain inferred from per-side value uniqueness. */
  grain: Grain;
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
  /** Minimum number of shared normalized values. Default 2. */
  minSharedValues?: number;
};

const DEFAULT_MIN_OVERLAP = 0.3;
const DEFAULT_MIN_SHARED = 2;
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

function valueSet(field: SourceField, normalize: (value: string) => string): Set<string> {
  const set = new Set<string>();
  for (const sample of fieldValues(field)) {
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
  if (trimmed > raw) {
    issues.push("whitespace");
  }
  if (lowered > trimmed) {
    issues.push("case_mismatch");
  }
  if (full > lowered) {
    issues.push("leading_zeros");
  }
  if (isNumericType(left) !== isNumericType(right)) {
    issues.push("numeric_vs_text");
  }

  if (issues.length === 0) {
    return null;
  }

  return {
    issues,
    note: issues.map((issue) => ISSUE_NOTES[issue]).join("; "),
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
 * Infer the grain of a join between two columns from each side's uniqueness. A unique side is
 * the "one"; a side with duplicates is the "many".
 */
export function inferGrain(left: SourceField, right: SourceField): Grain {
  const leftRole = keyRole(left);
  const rightRole = keyRole(right);

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
      if (field.type === "bool" || !stats || stats.nonEmpty < minRows) {
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

export type SemanticType =
  | "email"
  | "url"
  | "uuid"
  | "phone"
  | "timestamp"
  | "currency_amount"
  | "postal_code"
  | "latitude"
  | "longitude";

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
    semantic: "postal_code",
    nameHint: /zip|postal/i,
    test: (value) => /^\d{5}(-\d{4})?$/.test(value.trim()),
  },
  {
    semantic: "phone",
    nameHint: /phone|mobile|tel|fax/i,
    test: (value) => {
      const trimmed = value.trim();
      return /^\+?[0-9()\s.-]{7,20}$/.test(trimmed) && (trimmed.match(/\d/g)?.length ?? 0) >= 7;
    },
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
export function detectJoinKeys(sources: Source[], options?: DetectOptions): JoinKeyCandidate[] {
  const minOverlap = options?.minOverlap ?? DEFAULT_MIN_OVERLAP;
  const minShared = options?.minSharedValues ?? DEFAULT_MIN_SHARED;

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
        for (const rightField of rightSource.fields) {
          const left = setsFor(leftField);
          const right = setsFor(rightField);
          const rawOverlap = jaccard(left.raw, right.raw);
          const sharedValues = intersectionSize(left.full, right.full);
          const normalizedOverlap = jaccard(left.full, right.full);

          if (normalizedOverlap < minOverlap || sharedValues < minShared) {
            continue;
          }

          const formatMismatch = detectFormatMismatch(leftField, rightField);

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
            requiresNormalization:
              normalizedOverlap - rawOverlap > NORMALIZATION_EPSILON || formatMismatch !== null,
            formatMismatch,
            grain: inferGrain(leftField, rightField),
          });
        }
      }
    }
  }

  candidates.sort(
    (a, b) =>
      b.normalizedOverlap - a.normalizedOverlap ||
      b.sharedValues - a.sharedValues ||
      compareRefs(a.left, b.left) ||
      compareRefs(a.right, b.right),
  );

  return candidates;
}
