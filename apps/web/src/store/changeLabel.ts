import type { ApplyResult, Schema } from "@grafture/core";

type Applied = ApplyResult["applied"];

/**
 * Names for the tables an applied action touched. A removal's table is gone from the resulting
 * schema, so the pre-change schema is consulted as a fallback — a step labelled
 * "Remove table <uuid>" would be worse than useless in the history box.
 */
function tableNames(before: Schema, after: Schema, tableIds: string[]): string[] {
  return tableIds.map((id) => {
    const found =
      after.tables.find((table) => table.id === id) ??
      before.tables.find((table) => table.id === id);
    return found?.name ?? "table";
  });
}

function describeOne(before: Schema, after: Schema, entry: Applied[number]): string {
  const [first = "table", second = "table"] = tableNames(before, after, entry.tableIds);

  switch (entry.op) {
    case "add_table":
      return `Add table ${first}`;
    case "remove_table":
      return `Remove table ${first}`;
    case "rename_table":
      return `Rename table ${first}`;
    case "add_field":
      return `Add field to ${first}`;
    case "remove_field":
      return `Remove field from ${first}`;
    case "rename_field":
      return `Rename field in ${first}`;
    case "set_pk":
      return `Set primary key in ${first}`;
    case "set_type":
      return `Change field type in ${first}`;
    case "add_relationship":
      return `Link ${first} → ${second}`;
    case "remove_relationship":
      return `Unlink ${first} → ${second}`;
    case "set_cardinality":
      return `Change cardinality ${first} → ${second}`;
    default:
      return entry.op;
  }
}

export type ChangeDescription = {
  /** The one-line step name. */
  label: string;
  /**
   * One line per action, for a batch that a count alone cannot explain. Empty for a single-action
   * step — the label already _is_ the detail there, and a disclosure that opens onto a restatement
   * of the row above it is noise.
   */
  details: string[];
};

/**
 * Name an undo step from what `applyActions` actually applied — never from what was requested, so
 * a batch whose middle action was rejected is described by the changes the user can really walk
 * back. A multi-action batch (a copilot turn) collapses to a count, and keeps the per-action lines
 * so the history box can expand it: "7 changes" is honest about the size of an undo but says
 * nothing about whether you want it.
 */
export function describeChange(before: Schema, after: Schema, applied: Applied): ChangeDescription {
  if (applied.length === 0) {
    return { label: "No change", details: [] };
  }
  if (applied.length === 1) {
    const [only] = applied;
    return { label: only ? describeOne(before, after, only) : "No change", details: [] };
  }
  return {
    label: `${applied.length} changes`,
    details: applied.map((entry) => describeOne(before, after, entry)),
  };
}
