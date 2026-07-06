import type { FieldStats } from "./types.js";

export const MAX_SCAN_ROWS = 1000;
export const MAX_INFERENCE_VALUES = 200;
export const MAX_SAMPLES = 5;
/** Cap on retained row tuples (`Source.sampleRows`) — enough for multi-column uniqueness checks. */
export const MAX_ROW_TUPLES = 200;
/** Cap on retained per-field top-value frequencies (`FieldStats.topValues`). */
export const MAX_TOP_VALUES = 8;

/** A plain numeric literal — the shape min/max range stats are computed over. */
const NUMERIC_VALUE = /^-?\d+(\.\d+)?$/;
/** Leading zeros mark codes/identifiers (zero-padded zips, padded ids), not quantities. */
const LEADING_ZERO = /^-?0\d/;

/**
 * The number a value contributes to range stats, or null when it must not: not a plain
 * numeric literal, zero-padded (Number("02139") would silently strip the padding), or
 * beyond safe-integer precision (18+-digit account numbers round in IEEE-754 doubles).
 */
function asRangeNumber(value: string): number | null {
  if (!NUMERIC_VALUE.test(value) || LEADING_ZERO.test(value)) {
    return null;
  }
  const parsed = Number(value);
  return Math.abs(parsed) <= Number.MAX_SAFE_INTEGER ? parsed : null;
}

/**
 * Pick up to `limit` rows spread evenly across the whole file, preserving order. A head slice
 * (`rows.slice(0, limit)`) is biased on sorted files — a status column sorted by status looks
 * single-valued, and two files sorted differently can show zero join overlap because their scan
 * windows cover different entity ranges. Even spacing samples every region of the file and is
 * fully deterministic (same input, same rows), unlike a classic RNG reservoir.
 */
export function sampleScanRows<T>(rows: T[], limit: number = MAX_SCAN_ROWS): T[] {
  if (rows.length <= limit) {
    return rows;
  }
  const sampled: T[] = [];
  for (let i = 0; i < limit; i++) {
    sampled.push(rows[Math.floor((i * rows.length) / limit)] as T);
  }
  return sampled;
}

/**
 * Case-insensitive tokens real exports use for missing data ("#N/A" is Excel's error literal,
 * "nan" comes from pandas). Treating them as blank keeps the content-aware evidence honest: a
 * column that is 30% "N/A" is not a primary-key candidate, and "NULL" is not a join value.
 * Deliberately conservative — ambiguous strings that can be legitimate values ("NA" the country
 * code, "none" the option) are NOT included.
 */
const NULL_TOKENS = new Set(["", "null", "n/a", "#n/a", "nan", "-", "--"]);

/** Is this cell a real value, or empty/missing (including textual null tokens)? */
export function isNullToken(value: string | null | undefined): boolean {
  return value === null || value === undefined || NULL_TOKENS.has(value.trim().toLowerCase());
}

function isNonEmpty(value: string | null | undefined): value is string {
  return !isNullToken(value);
}

/**
 * Distinct / non-empty / blank counts over the scanned rows (up to MAX_SCAN_ROWS, sampled
 * evenly across the file by the parsers via `sampleScanRows`). Used by the SS-9 detectors to
 * reason about uniqueness (PK candidates) and join grain. Unlike `collectSamples`, this scans
 * every value in the window — uniqueness needs the full count, not just the first 5 distinct
 * samples.
 */
export function collectStats(values: string[]): FieldStats {
  // Insertion order is preserved, so equal counts later sort by first appearance.
  const counts = new Map<string, number>();
  let nonEmpty = 0;
  let blank = 0;
  let min = Number.POSITIVE_INFINITY;
  let max = Number.NEGATIVE_INFINITY;
  // The range is only honest when EVERY non-empty value contributes to it: a partial range
  // over the numeric subset of a mixed or identifier-like column reads as evidence about
  // values it never saw.
  let allNumeric = true;
  const limit = Math.min(values.length, MAX_SCAN_ROWS);

  for (let i = 0; i < limit; i++) {
    const value = values[i];
    if (!isNonEmpty(value)) {
      blank += 1;
      continue;
    }
    nonEmpty += 1;
    counts.set(value, (counts.get(value) ?? 0) + 1);

    const parsed = asRangeNumber(value.trim());
    if (parsed === null) {
      allNumeric = false;
    } else {
      min = Math.min(min, parsed);
      max = Math.max(max, parsed);
    }
  }

  // Only values that actually repeat carry skew/enum information; a fully-unique column
  // (ids) would just leak arbitrary values into every persisted stats block.
  const topValues = [...counts.entries()]
    .filter(([, count]) => count >= 2)
    .sort((a, b) => b[1] - a[1])
    .slice(0, MAX_TOP_VALUES)
    .map(([value, count]) => ({ value, count }));

  return {
    nonEmpty,
    distinct: counts.size,
    blank,
    ...(nonEmpty > 0 && allNumeric ? { min, max } : {}),
    ...(topValues.length > 0 ? { topValues } : {}),
  };
}

/**
 * Every distinct non-empty value in the scan window, first-seen order. Powers the join-key
 * detectors: overlap between two columns is only measurable over the real value sets, not the
 * 5-value display samples. Bounded by MAX_SCAN_ROWS, so at most ~1000 strings per field.
 */
export function collectDistinctValues(values: string[]): string[] {
  const result: string[] = [];
  const seen = new Set<string>();
  const limit = Math.min(values.length, MAX_SCAN_ROWS);

  for (let i = 0; i < limit; i++) {
    const value = values[i];
    if (!isNonEmpty(value) || seen.has(value)) {
      continue;
    }
    seen.add(value);
    result.push(value);
  }

  return result;
}

/** Collect up to 5 distinct non-empty samples in first-seen order. */
export function collectSamples(values: string[]): string[] {
  const samples: string[] = [];
  const seen = new Set<string>();
  const limit = Math.min(values.length, MAX_SCAN_ROWS);

  for (let i = 0; i < limit; i++) {
    const value = values[i];
    if (!isNonEmpty(value) || seen.has(value)) {
      continue;
    }
    seen.add(value);
    samples.push(value);
    if (samples.length >= MAX_SAMPLES) {
      break;
    }
  }

  return samples;
}

/** First ~200 non-empty values for type inference. */
export function collectInferenceValues(values: string[]): string[] {
  const result: string[] = [];
  const limit = Math.min(values.length, MAX_SCAN_ROWS);

  for (let i = 0; i < limit && result.length < MAX_INFERENCE_VALUES; i++) {
    const value = values[i];
    if (isNonEmpty(value)) {
      result.push(value);
    }
  }

  return result;
}
