import { z } from "zod";

export const InferredTypeSchema = z.enum(["int", "numeric", "bool", "date", "timestamp", "text"]);
export type InferredType = z.infer<typeof InferredTypeSchema>;

export const SourceKindSchema = z.enum(["csv", "xlsx", "json"]);
export type SourceKind = z.infer<typeof SourceKindSchema>;

/**
 * Per-field value statistics over the scanned rows. These power the content-aware
 * detectors (SS-9): a field that is unique and non-blank is a primary-key candidate, and
 * the ratio of distinct values on each side of a join tells us its grain (1:1 vs 1:N).
 * Counts are over up to ~1000 rows sampled evenly across the file, so `distinct` is a lower
 * bound for very large files — the *ratio* stays a reliable signal.
 */
/** One repeating value and how often it occurred in the scan window. */
export const ValueFrequencySchema = z.object({
  value: z.string(),
  count: z.number(),
});
export type ValueFrequency = z.infer<typeof ValueFrequencySchema>;

export const FieldStatsSchema = z.object({
  /** Non-empty values scanned. */
  nonEmpty: z.number(),
  /** Distinct non-empty values among those scanned. */
  distinct: z.number(),
  /** Empty/missing values scanned. */
  blank: z.number(),
  /**
   * Numeric range over the scanned values. Present only when EVERY non-empty value is a
   * plain, safe number without leading zeros — identifier-like columns (zero-padded zips,
   * account numbers past safe-integer precision) and mixed columns carry no range, so this
   * evidence is never lossy or misleading. Range evidence lets consumers judge plausibility
   * (a [-90, 90] column can be a latitude; a [0, 120] one is more likely an age).
   */
  min: z.number().optional(),
  max: z.number().optional(),
  /**
   * The most frequent *repeating* values (count ≥ 2), most frequent first, capped at
   * MAX_TOP_VALUES. Skew/enum evidence: distinct counts alone can't show that one status
   * value covers 95% of rows. Omitted when every scanned value is unique.
   */
  topValues: z.array(ValueFrequencySchema).optional(),
});
export type FieldStats = z.infer<typeof FieldStatsSchema>;

export const SourceFieldSchema = z.object({
  name: z.string(),
  type: InferredTypeSchema,
  samples: z.array(z.string()),
  /** Optional — older persisted sources may predate stats capture. */
  stats: FieldStatsSchema.optional(),
  /**
   * Distinct non-empty values over the scanned rows (first-seen order, capped at
   * MAX_SCAN_ROWS). This is the value set the join-key detectors compare — the 5-value
   * `samples` are a display/prompt digest and far too small to measure overlap between
   * real files. Optional: older persisted sources fall back to `samples`.
   */
  distinctValues: z.array(z.string()).optional(),
});
export type SourceField = z.infer<typeof SourceFieldSchema>;

export const SourceSchema = z.object({
  id: z.string(),
  name: z.string(),
  kind: SourceKindSchema,
  fields: z.array(SourceFieldSchema),
  /**
   * Row tuples sampled evenly across the scan window (at most MAX_ROW_TUPLES rows), each
   * aligned with `fields` order. Per-field value sets cannot answer multi-column questions —
   * composite-key uniqueness and functional dependencies need co-occurring values from the
   * same row. Optional: omitted for multi-sheet XLSX (columns come from different sheets, so
   * no single row matrix exists) and for sources persisted before capture.
   */
  sampleRows: z.array(z.array(z.string())).optional(),
  /**
   * Total data rows in the file (records for JSON), excluding the header. Unlike the per-field
   * `stats`, this is the *full* count — it is not capped at `MAX_SCAN_ROWS` — so the UI can show
   * true source size. Optional: older persisted sources predate row-count capture.
   */
  rowCount: z.number().int().nonnegative().optional(),
});
export type Source = z.infer<typeof SourceSchema>;
