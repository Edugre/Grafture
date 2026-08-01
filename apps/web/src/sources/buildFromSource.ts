import type { Schema, Source, SourceField } from "@grafture/core";

import type { RunActionsOptions, RunActionsResult } from "../store/index.js";
import { tableNameForSource, uniqueTableName } from "./tableName.js";

type RunActions = (rawActions: unknown[], opts?: RunActionsOptions) => RunActionsResult;
type AddField = (
  tableId: string,
  name: string,
  opts?: { type?: string; pk?: boolean; fk?: boolean },
) => RunActionsResult;

/**
 * The parser-injected surrogate field carrying this source's half of the structural
 * parent↔child link (see core's parseJson). Matched by the `synthetic` flag, never by name —
 * a real data column named `_rowId`/`_parentId` forces the parser to rename the surrogate.
 */
function surrogateField(source: Source): SourceField | undefined {
  return source.fields.find((field) => field.synthetic);
}

/** The canvas table built from `source`, matched by base name and a required field. */
function tableFor(schema: Schema, source: Source, fieldName: string) {
  const base = tableNameForSource(source).toLowerCase();
  const hasField = (table: Schema["tables"][number]) =>
    table.fields.some((field) => field.name.toLowerCase() === fieldName.toLowerCase());

  return (
    schema.tables.find((table) => table.name.toLowerCase() === base && hasField(table)) ??
    schema.tables.find((table) => table.name.toLowerCase().startsWith(base) && hasField(table))
  );
}

/**
 * Build a table from a source in one validated batch, wiring the structural child→parent 1:N
 * relationship on the surrogate pair whenever the other side's table is already on the canvas —
 * building a child links it to its parent's table, and building a parent backfills the link to
 * any of its children built earlier, so build order doesn't decide whether the link exists. The
 * surrogate pair is excluded from the overlap detectors, so this is the only deterministic path
 * that links them.
 */
export function buildTableFromSource(
  runActions: RunActions,
  schema: Schema,
  source: Source,
  allSources: Source[] = [],
): RunActionsResult & { tableName: string } {
  const base = tableNameForSource(source);
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

  const ownSurrogate = surrogateField(source);

  if (source.derivedFrom && ownSurrogate) {
    // Child being built: link to the parent's table if it's already on the canvas.
    const parent = allSources.find((entry) => entry.id === source.derivedFrom?.parentId);
    const parentSurrogate = parent ? surrogateField(parent) : undefined;
    const parentTable =
      parent && parentSurrogate ? tableFor(schema, parent, parentSurrogate.name) : undefined;
    if (parentTable && parentSurrogate) {
      actions.push({
        op: "add_relationship",
        from_table: parentTable.name,
        from_field: parentSurrogate.name,
        to_table: tableName,
        to_field: ownSurrogate.name,
        cardinality: "1:N",
      });
    }
  } else if (ownSurrogate) {
    // Parent being built: backfill the link to any child tables built before this one.
    for (const child of allSources) {
      if (child.derivedFrom?.parentId !== source.id) {
        continue;
      }
      const childSurrogate = surrogateField(child);
      const childTable = childSurrogate ? tableFor(schema, child, childSurrogate.name) : undefined;
      if (childTable && childSurrogate) {
        actions.push({
          op: "add_relationship",
          from_table: tableName,
          from_field: ownSurrogate.name,
          to_table: childTable.name,
          to_field: childSurrogate.name,
          cardinality: "1:N",
        });
      }
    }
  }

  // `imported`, not `user`: these columns are the file's own shape, read straight off the parsed
  // source. Distinguishing that from a shape someone chose is the point of recording origin.
  const result = runActions(actions, { actor: "imported" });

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
