import type { Schema, Source, SourceField } from "@schema-studio/core";

import type { RunActionsResult } from "../store/index.js";
import { tableNameFromFilename, uniqueTableName } from "./tableName.js";

type RunActions = (rawActions: unknown[]) => RunActionsResult;
type AddField = (
  tableId: string,
  name: string,
  opts?: { type?: string; pk?: boolean; fk?: boolean },
) => RunActionsResult;

export function buildTableFromSource(
  runActions: RunActions,
  schema: Schema,
  source: Source,
): RunActionsResult & { tableName: string } {
  const base = tableNameFromFilename(source.name);
  const tableName = uniqueTableName(schema, base);

  const result = runActions([
    {
      op: "add_table",
      name: tableName,
      fields: source.fields.map((field) => ({
        name: field.name,
        type: field.type,
      })),
    },
  ]);

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
