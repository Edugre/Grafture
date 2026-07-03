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
export const FieldStatsSchema = z.object({
  /** Non-empty values scanned. */
  nonEmpty: z.number(),
  /** Distinct non-empty values among those scanned. */
  distinct: z.number(),
  /** Empty/missing values scanned. */
  blank: z.number(),
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
   * Total data rows in the file (records for JSON), excluding the header. Unlike the per-field
   * `stats`, this is the *full* count — it is not capped at `MAX_SCAN_ROWS` — so the UI can show
   * true source size. Optional: older persisted sources predate row-count capture.
   */
  rowCount: z.number().int().nonnegative().optional(),
});
export type Source = z.infer<typeof SourceSchema>;
