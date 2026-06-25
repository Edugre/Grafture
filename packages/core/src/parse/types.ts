import { z } from "zod";

export const InferredTypeSchema = z.enum(["int", "numeric", "bool", "date", "text"]);
export type InferredType = z.infer<typeof InferredTypeSchema>;

export const SourceKindSchema = z.enum(["csv", "xlsx", "json"]);
export type SourceKind = z.infer<typeof SourceKindSchema>;

/**
 * Per-field value statistics over the scanned rows. These power the content-aware
 * detectors (SS-9): a field that is unique and non-blank is a primary-key candidate, and
 * the ratio of distinct values on each side of a join tells us its grain (1:1 vs 1:N).
 * Counts are over the first ~1000 scanned rows, so `distinct` is a lower bound for very
 * large files — the *ratio* stays a reliable signal.
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
});
export type SourceField = z.infer<typeof SourceFieldSchema>;

export const SourceSchema = z.object({
  id: z.string(),
  name: z.string(),
  kind: SourceKindSchema,
  fields: z.array(SourceFieldSchema),
});
export type Source = z.infer<typeof SourceSchema>;
