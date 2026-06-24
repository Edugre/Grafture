import type { Schema } from "@schema-studio/core";

import type { RunActionsResult } from "../store/index.js";

function tableName(schema: Schema, tableId: string): string {
  return schema.tables.find((table) => table.id === tableId)?.name ?? tableId;
}

function describeAction(action: unknown): string {
  if (typeof action !== "object" || action === null || !("op" in action)) {
    return "unknown action";
  }

  const op = String(action.op);
  const payload = action as Record<string, unknown>;

  switch (op) {
    case "add_table":
      return `add table "${String(payload["name"] ?? "")}"`;
    case "add_field":
      return `add field "${String(payload["name"] ?? "")}" to ${String(payload["table"] ?? "")}`;
    case "remove_field":
      return `remove field "${String(payload["field"] ?? "")}" from ${String(payload["table"] ?? "")}`;
    case "remove_table":
      return `remove table "${String(payload["table"] ?? "")}"`;
    case "rename_table":
      return `rename table "${String(payload["table"] ?? "")}" → "${String(payload["new_name"] ?? "")}"`;
    case "add_relationship":
      return `link ${String(payload["from_table"] ?? "")}.${String(payload["from_field"] ?? "")} → ${String(payload["to_table"] ?? "")}.${String(payload["to_field"] ?? "")}`;
    case "remove_relationship":
      return `unlink ${String(payload["from_table"] ?? "")}.${String(payload["from_field"] ?? "")} → ${String(payload["to_table"] ?? "")}.${String(payload["to_field"] ?? "")}`;
    default:
      return op;
  }
}

export function formatRejectedAction(action: unknown, reason: string): string {
  return `Couldn't apply ${describeAction(action)}: ${reason}`;
}

export function summarizeAppliedActions(
  schema: Schema,
  applied: RunActionsResult["applied"],
): string[] {
  return applied.map((entry) => {
    const tableNames = entry.tableIds.map((id) => tableName(schema, id)).join(", ");
    const tables = tableNames ? ` (${tableNames})` : "";
    return `${entry.op}${tables}`;
  });
}

export function collectAffectedTableIds(applied: RunActionsResult["applied"]): string[] {
  const ids = new Set<string>();
  for (const entry of applied) {
    for (const tableId of entry.tableIds) {
      ids.add(tableId);
    }
  }
  return [...ids];
}
