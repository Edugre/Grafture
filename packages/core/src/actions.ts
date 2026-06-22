import { z } from "zod";

import type { Schema } from "./model.js";

const addTableActionSchema = z.object({
  type: z.literal("add_table"),
  table: z.object({
    id: z.string(),
    name: z.string(),
    x: z.number(),
    y: z.number(),
    fields: z.array(
      z.object({
        id: z.string(),
        name: z.string(),
        type: z.string(),
        pk: z.boolean(),
        fk: z.boolean(),
      }),
    ),
  }),
});

const addFieldActionSchema = z.object({
  type: z.literal("add_field"),
  tableId: z.string(),
  field: z.object({
    id: z.string(),
    name: z.string(),
    type: z.string(),
    pk: z.boolean(),
    fk: z.boolean(),
  }),
});

const removeFieldActionSchema = z.object({
  type: z.literal("remove_field"),
  tableId: z.string(),
  fieldId: z.string(),
});

const removeTableActionSchema = z.object({
  type: z.literal("remove_table"),
  tableId: z.string(),
});

const renameTableActionSchema = z.object({
  type: z.literal("rename_table"),
  tableId: z.string(),
  name: z.string(),
});

const addRelationshipActionSchema = z.object({
  type: z.literal("add_relationship"),
  relationship: z.object({
    id: z.string(),
    fromTable: z.string(),
    fromField: z.string(),
    toTable: z.string(),
    toField: z.string(),
    cardinality: z.enum(["1:1", "1:N", "N:M"]),
  }),
});

export const actionSchema = z.discriminatedUnion("type", [
  addTableActionSchema,
  addFieldActionSchema,
  removeFieldActionSchema,
  removeTableActionSchema,
  renameTableActionSchema,
  addRelationshipActionSchema,
]);

export type Action = z.infer<typeof actionSchema>;

export const actionsSchema = z.array(actionSchema);

export type ApplyActionsResult = { ok: true; schema: Schema } | { ok: false; errors: string[] };

export function applyActions(schema: Schema, actions: unknown[]): ApplyActionsResult {
  const parsed = actionsSchema.safeParse(actions);

  if (!parsed.success) {
    return {
      ok: false,
      errors: parsed.error.issues.map((issue) => issue.message),
    };
  }

  // Stub: validated actions are accepted but do not mutate the schema yet.
  return { ok: true, schema };
}
