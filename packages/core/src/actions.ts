import { z } from "zod";

import { CardinalitySchema, type Field, type Schema, type Table } from "./model.js";

const fieldInputSchema = z.object({
  name: z.string(),
  type: z.string().default("text"),
  pk: z.boolean().default(false),
  fk: z.boolean().default(false),
});

const addTableActionSchema = z.object({
  op: z.literal("add_table"),
  name: z.string(),
  x: z.number().optional(),
  y: z.number().optional(),
  fields: z.array(fieldInputSchema).optional(),
});

const addFieldActionSchema = z.object({
  op: z.literal("add_field"),
  table: z.string(),
  name: z.string(),
  type: z.string().default("text"),
  pk: z.boolean().default(false),
  fk: z.boolean().default(false),
});

const removeFieldActionSchema = z.object({
  op: z.literal("remove_field"),
  table: z.string(),
  field: z.string(),
});

const removeTableActionSchema = z.object({
  op: z.literal("remove_table"),
  table: z.string(),
});

const renameTableActionSchema = z.object({
  op: z.literal("rename_table"),
  table: z.string(),
  new_name: z.string(),
});

const addRelationshipActionSchema = z.object({
  op: z.literal("add_relationship"),
  from_table: z.string(),
  from_field: z.string(),
  to_table: z.string(),
  to_field: z.string(),
  cardinality: CardinalitySchema.default("1:N"),
});

const removeRelationshipActionSchema = z.object({
  op: z.literal("remove_relationship"),
  from_table: z.string(),
  from_field: z.string(),
  to_table: z.string(),
  to_field: z.string(),
});

export const SchemaActionSchema = z.discriminatedUnion("op", [
  addTableActionSchema,
  addFieldActionSchema,
  removeFieldActionSchema,
  removeTableActionSchema,
  renameTableActionSchema,
  addRelationshipActionSchema,
  removeRelationshipActionSchema,
]);

export type SchemaAction = z.infer<typeof SchemaActionSchema>;

export type ApplyResult = {
  schema: Schema;
  applied: Array<{ op: string; tableIds: string[]; relationshipId?: string }>;
  rejected: Array<{ action: unknown; reason: string }>;
};

export type ApplyActionsOptions = {
  makeId?: () => string;
};

function defaultMakeId(): string {
  return crypto.randomUUID();
}

function cloneSchema(schema: Schema): Schema {
  return structuredClone(schema);
}

function findTableByName(schema: Schema, name: string): Table | undefined {
  const lower = name.toLowerCase();
  return schema.tables.find((table) => table.name.toLowerCase() === lower);
}

function findFieldByName(table: Table, name: string): Field | undefined {
  const lower = name.toLowerCase();
  return table.fields.find((field) => field.name.toLowerCase() === lower);
}

function tableNameExists(schema: Schema, name: string, excludeTableId?: string): boolean {
  const lower = name.toLowerCase();
  return schema.tables.some(
    (table) => table.name.toLowerCase() === lower && table.id !== excludeTableId,
  );
}

function relationshipExists(
  schema: Schema,
  fromTableId: string,
  fromFieldId: string,
  toTableId: string,
  toFieldId: string,
): boolean {
  return schema.relationships.some(
    (relationship) =>
      relationship.fromTable === fromTableId &&
      relationship.fromField === fromFieldId &&
      relationship.toTable === toTableId &&
      relationship.toField === toFieldId,
  );
}

function removeRelationshipsForTable(schema: Schema, tableId: string): void {
  schema.relationships = schema.relationships.filter(
    (relationship) => relationship.fromTable !== tableId && relationship.toTable !== tableId,
  );
}

function removeRelationshipsForField(schema: Schema, tableId: string, fieldId: string): void {
  schema.relationships = schema.relationships.filter(
    (relationship) =>
      !(
        (relationship.fromTable === tableId && relationship.fromField === fieldId) ||
        (relationship.toTable === tableId && relationship.toField === fieldId)
      ),
  );
}

function cascadeTablePosition(tableCount: number): { x: number; y: number } {
  return { x: tableCount * 280, y: 0 };
}

export function applyActions(
  schema: Schema,
  rawActions: unknown,
  opts?: ApplyActionsOptions,
): ApplyResult {
  const makeId = opts?.makeId ?? defaultMakeId;

  if (!Array.isArray(rawActions)) {
    return {
      schema,
      applied: [],
      rejected: [{ action: rawActions, reason: "actions must be an array" }],
    };
  }

  const working = cloneSchema(schema);
  const applied: ApplyResult["applied"] = [];
  const rejected: ApplyResult["rejected"] = [];

  for (const rawAction of rawActions) {
    const parsed = SchemaActionSchema.safeParse(rawAction);

    if (!parsed.success) {
      rejected.push({
        action: rawAction,
        reason: parsed.error.issues.map((issue) => issue.message).join("; "),
      });
      continue;
    }

    const action = parsed.data;

    switch (action.op) {
      case "add_table": {
        if (findTableByName(working, action.name)) {
          rejected.push({
            action: rawAction,
            reason: `table '${action.name}' already exists`,
          });
          break;
        }

        const position =
          action.x !== undefined && action.y !== undefined
            ? { x: action.x, y: action.y }
            : action.x !== undefined
              ? { x: action.x, y: cascadeTablePosition(working.tables.length).y }
              : action.y !== undefined
                ? { x: cascadeTablePosition(working.tables.length).x, y: action.y }
                : cascadeTablePosition(working.tables.length);

        const tableId = makeId();
        const fields: Field[] = (action.fields ?? []).map((field) => ({
          id: makeId(),
          name: field.name,
          type: field.type,
          pk: field.pk,
          fk: field.fk,
        }));

        working.tables.push({
          id: tableId,
          name: action.name,
          x: position.x,
          y: position.y,
          fields,
        });

        applied.push({ op: action.op, tableIds: [tableId] });
        break;
      }

      case "add_field": {
        const table = findTableByName(working, action.table);
        if (!table) {
          rejected.push({
            action: rawAction,
            reason: `table '${action.table}' not found`,
          });
          break;
        }

        if (findFieldByName(table, action.name)) {
          rejected.push({
            action: rawAction,
            reason: `field '${action.name}' already exists in table '${table.name}'`,
          });
          break;
        }

        table.fields.push({
          id: makeId(),
          name: action.name,
          type: action.type,
          pk: action.pk,
          fk: action.fk,
        });

        applied.push({ op: action.op, tableIds: [table.id] });
        break;
      }

      case "remove_field": {
        const table = findTableByName(working, action.table);
        if (!table) {
          rejected.push({
            action: rawAction,
            reason: `table '${action.table}' not found`,
          });
          break;
        }

        const field = findFieldByName(table, action.field);
        if (!field) {
          rejected.push({
            action: rawAction,
            reason: `field '${action.field}' not found in table '${table.name}'`,
          });
          break;
        }

        table.fields = table.fields.filter((candidate) => candidate.id !== field.id);
        removeRelationshipsForField(working, table.id, field.id);

        applied.push({ op: action.op, tableIds: [table.id] });
        break;
      }

      case "remove_table": {
        const table = findTableByName(working, action.table);
        if (!table) {
          rejected.push({
            action: rawAction,
            reason: `table '${action.table}' not found`,
          });
          break;
        }

        working.tables = working.tables.filter((candidate) => candidate.id !== table.id);
        removeRelationshipsForTable(working, table.id);

        applied.push({ op: action.op, tableIds: [table.id] });
        break;
      }

      case "rename_table": {
        const table = findTableByName(working, action.table);
        if (!table) {
          rejected.push({
            action: rawAction,
            reason: `table '${action.table}' not found`,
          });
          break;
        }

        if (tableNameExists(working, action.new_name, table.id)) {
          rejected.push({
            action: rawAction,
            reason: `table '${action.new_name}' already exists`,
          });
          break;
        }

        table.name = action.new_name;
        applied.push({ op: action.op, tableIds: [table.id] });
        break;
      }

      case "add_relationship": {
        const fromTable = findTableByName(working, action.from_table);
        if (!fromTable) {
          rejected.push({
            action: rawAction,
            reason: `table '${action.from_table}' not found`,
          });
          break;
        }

        const toTable = findTableByName(working, action.to_table);
        if (!toTable) {
          rejected.push({
            action: rawAction,
            reason: `table '${action.to_table}' not found`,
          });
          break;
        }

        const fromField = findFieldByName(fromTable, action.from_field);
        if (!fromField) {
          rejected.push({
            action: rawAction,
            reason: `field '${action.from_field}' not found in table '${fromTable.name}'`,
          });
          break;
        }

        const toField = findFieldByName(toTable, action.to_field);
        if (!toField) {
          rejected.push({
            action: rawAction,
            reason: `field '${action.to_field}' not found in table '${toTable.name}'`,
          });
          break;
        }

        if (relationshipExists(working, fromTable.id, fromField.id, toTable.id, toField.id)) {
          rejected.push({
            action: rawAction,
            reason: "relationship already exists",
          });
          break;
        }

        const relationshipId = makeId();
        working.relationships.push({
          id: relationshipId,
          fromTable: fromTable.id,
          fromField: fromField.id,
          toTable: toTable.id,
          toField: toField.id,
          cardinality: action.cardinality,
        });

        applied.push({
          op: action.op,
          tableIds: [fromTable.id, toTable.id],
          relationshipId,
        });
        break;
      }

      case "remove_relationship": {
        const fromTable = findTableByName(working, action.from_table);
        if (!fromTable) {
          rejected.push({ action: rawAction, reason: `table '${action.from_table}' not found` });
          break;
        }

        const toTable = findTableByName(working, action.to_table);
        if (!toTable) {
          rejected.push({ action: rawAction, reason: `table '${action.to_table}' not found` });
          break;
        }

        const fromField = findFieldByName(fromTable, action.from_field);
        if (!fromField) {
          rejected.push({
            action: rawAction,
            reason: `field '${action.from_field}' not found in table '${fromTable.name}'`,
          });
          break;
        }

        const toField = findFieldByName(toTable, action.to_field);
        if (!toField) {
          rejected.push({
            action: rawAction,
            reason: `field '${action.to_field}' not found in table '${toTable.name}'`,
          });
          break;
        }

        const relationship = working.relationships.find(
          (candidate) =>
            candidate.fromTable === fromTable.id &&
            candidate.fromField === fromField.id &&
            candidate.toTable === toTable.id &&
            candidate.toField === toField.id,
        );
        if (!relationship) {
          rejected.push({
            action: rawAction,
            reason: `no relationship from '${fromTable.name}.${fromField.name}' to '${toTable.name}.${toField.name}'`,
          });
          break;
        }

        working.relationships = working.relationships.filter(
          (candidate) => candidate.id !== relationship.id,
        );

        applied.push({
          op: action.op,
          tableIds: [fromTable.id, toTable.id],
          relationshipId: relationship.id,
        });
        break;
      }
    }
  }

  return { schema: working, applied, rejected };
}
