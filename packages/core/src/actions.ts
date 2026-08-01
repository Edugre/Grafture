import { z } from "zod";

import {
  CardinalitySchema,
  type Field,
  type Origin,
  type Provenance,
  type Rationale,
  type Relationship,
  type Schema,
  type Table,
} from "./model.js";

/**
 * The rationale the copilot supplies alongside a decision. `turnId` is deliberately absent: it
 * identifies the copilot turn and is supplied by the caller, not the model — a model asked for an
 * id it cannot know would invent one.
 */
const rationaleInputSchema = z.object({
  text: z.string().min(1),
  evidence: z.array(z.string()).default([]),
});

const fieldInputSchema = z.object({
  name: z.string(),
  type: z.string().default("text"),
  pk: z.boolean().default(false),
  fk: z.boolean().default(false),
});

/**
 * `rationale` is declared ahead of the decision fields on every op that carries one. Generation is
 * autoregressive, so a reason emitted before the choice conditions it, while one emitted after can
 * only rationalize a choice already made. The zod key order documents that intent; what actually
 * holds the model to it is the ordering of the examples in the system prompt, since the response
 * tool types `actions` loosely as `object[]`.
 */
const addTableActionSchema = z.object({
  rationale: rationaleInputSchema.optional(),
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

const renameFieldActionSchema = z.object({
  op: z.literal("rename_field"),
  table: z.string(),
  field: z.string(),
  new_name: z.string(),
});

const addRelationshipActionSchema = z.object({
  rationale: rationaleInputSchema.optional(),
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

const setPkActionSchema = z.object({
  rationale: rationaleInputSchema.optional(),
  op: z.literal("set_pk"),
  table: z.string(),
  field: z.string(),
  pk: z.boolean(),
});

const setTypeActionSchema = z.object({
  rationale: rationaleInputSchema.optional(),
  op: z.literal("set_type"),
  table: z.string(),
  field: z.string(),
  type: z.string(),
});

const setCardinalityActionSchema = z.object({
  rationale: rationaleInputSchema.optional(),
  op: z.literal("set_cardinality"),
  from_table: z.string(),
  from_field: z.string(),
  to_table: z.string(),
  to_field: z.string(),
  cardinality: CardinalitySchema,
});

export const SchemaActionSchema = z.discriminatedUnion("op", [
  addTableActionSchema,
  addFieldActionSchema,
  removeFieldActionSchema,
  removeTableActionSchema,
  renameTableActionSchema,
  renameFieldActionSchema,
  addRelationshipActionSchema,
  removeRelationshipActionSchema,
  setPkActionSchema,
  setTypeActionSchema,
  setCardinalityActionSchema,
]);

export type SchemaAction = z.infer<typeof SchemaActionSchema>;

export type ApplyResult = {
  schema: Schema;
  applied: Array<{ op: string; tableIds: string[]; relationshipId?: string }>;
  rejected: Array<{ action: unknown; reason: string }>;
};

export type ApplyActionsOptions = {
  makeId?: () => string;
  /**
   * Who is applying these actions. Manual edits and copilot output both flow through
   * `applyActions`, so it cannot infer the actor and must not guess — the caller supplies it.
   * Defaults to `"user"`, which is the safe reading: an unattributed edit is the user's.
   */
  actor?: Origin;
  /**
   * Identifies the copilot turn these actions came from, stamped onto any rationale so the review
   * panel can group a turn's reasoning. Supplied by the caller because the model cannot know it.
   */
  turnId?: string;
};

function defaultMakeId(): string {
  return crypto.randomUUID();
}

function stamp(actor: Origin): Provenance {
  return { origin: actor, touched: false };
}

/**
 * Record that an entity was modified by someone other than whoever created it. That difference —
 * not merely "was edited" — is the signal that invalidates a rationale: the copilot revising its
 * own proposal leaves the explanation true, while a hand edit to the same entity does not.
 *
 * Entities with no provenance (built before this existed, or imported) are left alone rather than
 * back-filled: inventing an origin we never observed would be a worse record than none.
 */
function markTouched(target: { provenance?: Provenance | undefined }, actor: Origin): void {
  const provenance = target.provenance;
  if (!provenance) {
    return;
  }

  // Once an entity carries a rationale, staleness is judged against whoever wrote that
  // explanation — and only the copilot ever writes one — so authorship decides in both
  // directions and origin stops mattering.
  //
  // Origin alone is not enough: the copilot can explain an entity it did not create (a legacy or
  // imported column), which lands as `origin: "user"`. Under an origin-only rule a user edit to
  // that column matched its own origin, left `touched` false, and let a now-wrong explanation
  // keep presenting itself as current — the exact failure this feature exists to prevent. Found
  // by driving the real app, not by the suite.
  if (provenance.rationale !== undefined) {
    provenance.touched = actor !== "ai";
    return;
  }

  if (provenance.origin === actor) {
    return;
  }
  provenance.touched = true;
}

/**
 * Record why the copilot made this decision. Dropped for non-AI actors: a reason attached to a
 * hand edit is not provenance, it is the user narrating their own work, and nothing reads it.
 *
 * Writing a rationale clears `touched`, and the order matters — this runs *after* `markTouched`.
 * `touched` means "drifted from the last authoritative explanation"; a rationale written now *is*
 * that explanation, so the entity is current again by definition. Without the reset, the copilot
 * re-deciding a cardinality the user had edited would render its own fresh reasoning as stale.
 *
 * An entity with no provenance gets one materialized as `user` rather than having its rationale
 * dropped. That is the documented reading of absent provenance, not a new inference — and losing
 * the explanation silently is the failure mode this whole feature exists to prevent.
 */
function attachRationale(
  target: { provenance?: Provenance | undefined },
  input: { text: string; evidence: string[] } | undefined,
  actor: Origin,
  turnId: string | undefined,
): void {
  if (!input || actor !== "ai") {
    return;
  }

  const rationale: Rationale = {
    text: input.text,
    evidence: input.evidence,
    ...(turnId === undefined ? {} : { turnId }),
  };

  if (target.provenance) {
    target.provenance.rationale = rationale;
    target.provenance.touched = false;
    return;
  }

  target.provenance = { origin: "user", touched: false, rationale };
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

function removeRelationshipsForTable(schema: Schema, tableId: string): Relationship[] {
  const removed = schema.relationships.filter(
    (relationship) => relationship.fromTable === tableId || relationship.toTable === tableId,
  );
  schema.relationships = schema.relationships.filter(
    (relationship) => relationship.fromTable !== tableId && relationship.toTable !== tableId,
  );
  return removed;
}

function removeRelationshipsForField(
  schema: Schema,
  tableId: string,
  fieldId: string,
): Relationship[] {
  const matches = (relationship: Relationship): boolean =>
    (relationship.fromTable === tableId && relationship.fromField === fieldId) ||
    (relationship.toTable === tableId && relationship.toField === fieldId);
  const removed = schema.relationships.filter(matches);
  schema.relationships = schema.relationships.filter((relationship) => !matches(relationship));
  return removed;
}

/**
 * The `fk` flag on a field mirrors "this column is the from-side of some relationship" so the
 * canvas badge tracks reality. After relationships are removed, clear the flag on any from-field
 * that no longer sources a relationship (fields explicitly created with `fk: true` but never
 * linked are untouched — only fields whose relationship just went away are cleared).
 */
function clearOrphanedFkFlags(schema: Schema, removed: Relationship[]): void {
  for (const relationship of removed) {
    const stillSource = schema.relationships.some(
      (candidate) => candidate.fromField === relationship.fromField,
    );
    if (stillSource) {
      continue;
    }
    const table = schema.tables.find((candidate) => candidate.id === relationship.fromTable);
    const field = table?.fields.find((candidate) => candidate.id === relationship.fromField);
    if (field) {
      field.fk = false;
    }
  }
}

function cascadeTablePosition(tableCount: number): { x: number; y: number } {
  return { x: tableCount * 280, y: 0 };
}

/**
 * Make a list of field names unique within a table, case-insensitively (matching
 * `findFieldByName`). The whole action protocol addresses fields by name, so a table must never
 * hold two fields with the same name — otherwise every later name-based op (add_relationship,
 * set_pk, set_type, remove_field, …) would silently resolve to the first match and touch the wrong
 * field. `add_field` already rejects duplicates; `add_table` builds many fields at once, so it
 * disambiguates them here (`name`, `name_2`, …) rather than dropping any.
 */
function ensureUniqueFieldNames(names: string[]): string[] {
  const used = new Set<string>();
  return names.map((original) => {
    let candidate = original;
    let suffix = 2;
    while (used.has(candidate.toLowerCase())) {
      candidate = `${original}_${suffix}`;
      suffix += 1;
    }
    used.add(candidate.toLowerCase());
    return candidate;
  });
}

export function applyActions(
  schema: Schema,
  rawActions: unknown,
  opts?: ApplyActionsOptions,
): ApplyResult {
  const makeId = opts?.makeId ?? defaultMakeId;
  const actor: Origin = opts?.actor ?? "user";
  const turnId = opts?.turnId;

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
        const requestedFields = action.fields ?? [];
        const uniqueNames = ensureUniqueFieldNames(requestedFields.map((field) => field.name));
        const fields: Field[] = requestedFields.map((field, index) => ({
          id: makeId(),
          name: uniqueNames[index] ?? field.name,
          type: field.type,
          pk: field.pk,
          fk: field.fk,
          provenance: stamp(actor),
        }));

        const newTable: Table = {
          id: tableId,
          name: action.name,
          x: position.x,
          y: position.y,
          fields,
          provenance: stamp(actor),
        };
        working.tables.push(newTable);
        attachRationale(newTable, action.rationale, actor, turnId);

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
          provenance: stamp(actor),
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
        const removed = removeRelationshipsForField(working, table.id, field.id);
        clearOrphanedFkFlags(working, removed);

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
        const removed = removeRelationshipsForTable(working, table.id);
        clearOrphanedFkFlags(working, removed);

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
        markTouched(table, actor);
        applied.push({ op: action.op, tableIds: [table.id] });
        break;
      }

      case "rename_field": {
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

        if (action.new_name.trim() === "") {
          rejected.push({
            action: rawAction,
            reason: "new field name must not be empty",
          });
          break;
        }

        const existing = findFieldByName(table, action.new_name);
        if (existing && existing.id !== field.id) {
          rejected.push({
            action: rawAction,
            reason: `field '${action.new_name}' already exists in table '${table.name}'`,
          });
          break;
        }

        field.name = action.new_name;
        markTouched(field, actor);
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
        const newRelationship: Relationship = {
          id: relationshipId,
          fromTable: fromTable.id,
          fromField: fromField.id,
          toTable: toTable.id,
          toField: toField.id,
          cardinality: action.cardinality,
          provenance: stamp(actor),
        };
        working.relationships.push(newRelationship);
        attachRationale(newRelationship, action.rationale, actor, turnId);
        // The from-side column now sources a relationship — keep the FK badge in sync.
        fromField.fk = true;

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
        clearOrphanedFkFlags(working, [relationship]);

        applied.push({
          op: action.op,
          tableIds: [fromTable.id, toTable.id],
          relationshipId: relationship.id,
        });
        break;
      }

      case "set_pk": {
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

        field.pk = action.pk;
        markTouched(field, actor);
        attachRationale(field, action.rationale, actor, turnId);
        applied.push({ op: action.op, tableIds: [table.id] });
        break;
      }

      case "set_type": {
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

        field.type = action.type;
        markTouched(field, actor);
        attachRationale(field, action.rationale, actor, turnId);
        applied.push({ op: action.op, tableIds: [table.id] });
        break;
      }

      case "set_cardinality": {
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

        relationship.cardinality = action.cardinality;
        markTouched(relationship, actor);
        attachRationale(relationship, action.rationale, actor, turnId);

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
