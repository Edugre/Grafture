import { z } from "zod";

export const CardinalitySchema = z.enum(["1:1", "1:N", "N:M"]);
export type Cardinality = z.infer<typeof CardinalitySchema>;

/** Who created an entity. Set once at creation; never rewritten. */
export const OriginSchema = z.enum(["ai", "user", "imported"]);
export type Origin = z.infer<typeof OriginSchema>;

/**
 * Why the copilot proposed something, frozen at write time. Attached only to AI-origin entities
 * (wired in a later change) and never edited afterwards — an explanation the user can rewrite is
 * worthless as provenance.
 */
export const RationaleSchema = z.object({
  text: z.string(),
  /** Detector finding ids / probe results the reasoning cited. */
  evidence: z.array(z.string()).default([]),
  /** Copilot turn that produced it, for grouping in the review panel. */
  turnId: z.string().optional(),
});
export type Rationale = z.infer<typeof RationaleSchema>;

/**
 * Provenance covers the entity's **own** attributes: a table's provenance is about its name, a
 * field's about that field. "Is this table AI-generated?" is derived from its fields, never stored
 * — storing it there would force a single hand-renamed field to flip the whole table and discard
 * every still-valid rationale on the other fields.
 *
 * `origin` and `touched` are two independent bits rather than one enum so the mixed cases are
 * representable: a copilot proposal the user later edited, and a hand-built table the copilot
 * added to, are different states and only the first invalidates a rationale.
 */
export const ProvenanceSchema = z.object({
  origin: OriginSchema,
  /** Modified by someone other than its creator. Flips false→true once, never back. */
  touched: z.boolean().default(false),
  rationale: RationaleSchema.optional(),
});
export type Provenance = z.infer<typeof ProvenanceSchema>;

export const FieldSchema = z.object({
  id: z.string(),
  name: z.string(),
  type: z.string(),
  pk: z.boolean(),
  fk: z.boolean(),
  /** Absent on schemas built before provenance existed; reads as user-owned. */
  provenance: ProvenanceSchema.optional(),
});
export type Field = z.infer<typeof FieldSchema>;

export const TableSchema = z.object({
  id: z.string(),
  name: z.string(),
  x: z.number(),
  y: z.number(),
  /** Optional rendered width (px). Presentation geometry alongside x/y; defaults to the node width. */
  width: z.number().optional(),
  fields: z.array(FieldSchema),
  /** Covers the table's own name only — see `ProvenanceSchema`. */
  provenance: ProvenanceSchema.optional(),
});
export type Table = z.infer<typeof TableSchema>;

export const RelationshipSchema = z.object({
  id: z.string(),
  fromTable: z.string(),
  fromField: z.string(),
  toTable: z.string(),
  toField: z.string(),
  cardinality: CardinalitySchema,
  provenance: ProvenanceSchema.optional(),
});
export type Relationship = z.infer<typeof RelationshipSchema>;

export const SchemaSchema = z.object({
  tables: z.array(TableSchema),
  relationships: z.array(RelationshipSchema),
});
export type Schema = z.infer<typeof SchemaSchema>;

export const emptySchema = (): Schema => ({
  tables: [],
  relationships: [],
});
