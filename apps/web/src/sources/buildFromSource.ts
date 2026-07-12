import type { Schema, Source, SourceField } from "@grafture/core";

import type { RunActionsResult } from "../store/index.js";
import { tableNameFromFilename, uniqueTableName } from "./tableName.js";

type RunActions = (rawActions: unknown[]) => RunActionsResult;
type AddField = (
  tableId: string,
  name: string,
  opts?: { type?: string; pk?: boolean; fk?: boolean },
) => RunActionsResult;

/** Surrogate column names carrying the structural parent↔child link (see core's parseJson). */
const SYNTHETIC_ROW_ID = "_rowId";
const SYNTHETIC_PARENT_ID = "_parentId";

/** The canvas table built from `source`, matched by base name and a required field. */
function tableFor(schema: Schema, source: Source, fieldName: string) {
  const base = tableNameFromFilename(source.name).toLowerCase();
  const hasField = (table: Schema["tables"][number]) =>
    table.fields.some((field) => field.name.toLowerCase() === fieldName.toLowerCase());

  return (
    schema.tables.find((table) => table.name.toLowerCase() === base && hasField(table)) ??
    schema.tables.find((table) => table.name.toLowerCase().startsWith(base) && hasField(table))
  );
}

/**
 * Build a table from a source in one validated batch. When the source is a child unnested from
 * a JSON parent (`derivedFrom` lineage) and the parent's table is already on the canvas, the
 * structural child→parent 1:N relationship (`_parentId` → `_rowId`) is emitted in the same
 * batch — the surrogate pair is excluded from the overlap detectors, so this is the only
 * deterministic path that links them.
 */
export function buildTableFromSource(
  runActions: RunActions,
  schema: Schema,
  source: Source,
  allSources: Source[] = [],
): RunActionsResult & { tableName: string } {
  const base = tableNameFromFilename(source.name);
  const tableName = uniqueTableName(schema, base);

  const actions: unknown[] = [
    {
      op: "add_table",
      name: tableName,
      fields: source.fields.map((field) => ({
        name: field.name,
        type: field.type,
      })),
    },
  ];

  const hasParentLink = source.fields.some((field) => field.name === SYNTHETIC_PARENT_ID);
  if (source.derivedFrom && hasParentLink) {
    const parent = allSources.find((entry) => entry.id === source.derivedFrom?.parentId);
    const parentTable = parent ? tableFor(schema, parent, SYNTHETIC_ROW_ID) : undefined;
    if (parentTable) {
      actions.push({
        op: "add_relationship",
        from_table: parentTable.name,
        from_field: SYNTHETIC_ROW_ID,
        to_table: tableName,
        to_field: SYNTHETIC_PARENT_ID,
        cardinality: "1:N",
      });
    }
  }

  const result = runActions(actions);

  return { ...result, tableName };
}

export function addSourceFieldToTable(
  addField: AddField,
  tableId: string | undefined,
  field: SourceField,
): RunActionsResult | { error: string } {
  if (!tableId) {
    return { error: "Select a table on the canvas first." };
  }

  return addField(tableId, field.name, { type: field.type });
}

export function formatSample(field: SourceField): string | null {
  const sample = field.samples[0];
  return sample === undefined ? null : sample;
}
