import type { FieldStats } from "./types.js";

export const MAX_SCAN_ROWS = 1000;
export const MAX_INFERENCE_VALUES = 200;
export const MAX_SAMPLES = 5;

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
 * Distinct / non-empty / blank counts over the first ~1000 rows. Used by the SS-9
 * detectors to reason about uniqueness (PK candidates) and join grain. Unlike
 * `collectSamples`, this scans every value in the window — uniqueness needs the full count,
 * not just the first 5 distinct samples.
 */
export function collectStats(values: string[]): FieldStats {
  const distinctValues = new Set<string>();
  let nonEmpty = 0;
  let blank = 0;
  const limit = Math.min(values.length, MAX_SCAN_ROWS);

  for (let i = 0; i < limit; i++) {
    const value = values[i];
    if (isNonEmpty(value)) {
      nonEmpty += 1;
      distinctValues.add(value);
    } else {
      blank += 1;
    }
  }

  return { nonEmpty, distinct: distinctValues.size, blank };
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
