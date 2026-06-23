import type { Schema } from "@schema-studio/core";
import ELK from "elkjs/lib/elk.bundled.js";

import { NODE_WIDTH, tableNodeHeight } from "./constants.js";

export type TablePosition = { tableId: string; x: number; y: number };

const elk = new ELK();

/**
 * Run elk's layered algorithm over the schema and return one position per table.
 * The caller pushes these through the store (`moveTables`) so the move is undoable;
 * this function is pure and never touches diagram state itself.
 */
export async function layoutSchema(schema: Schema): Promise<TablePosition[]> {
  if (schema.tables.length === 0) {
    return [];
  }

  const graph = {
    id: "root",
    layoutOptions: {
      "elk.algorithm": "layered",
      "elk.direction": "RIGHT",
      "elk.spacing.nodeNode": "60",
      "elk.layered.spacing.nodeNodeBetweenLayers": "120",
    },
    children: schema.tables.map((table) => ({
      id: table.id,
      width: NODE_WIDTH,
      height: tableNodeHeight(table.fields.length),
    })),
    edges: schema.relationships.map((relationship) => ({
      id: relationship.id,
      sources: [relationship.fromTable],
      targets: [relationship.toTable],
    })),
  };

  const laidOut = await elk.layout(graph);

  return (laidOut.children ?? []).map((child) => ({
    tableId: child.id,
    x: child.x ?? 0,
    y: child.y ?? 0,
  }));
}
