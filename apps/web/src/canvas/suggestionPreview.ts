import type { Schema, Table } from "@schema-studio/core";

import { tableNameFromFilename } from "../sources/tableName.js";
import type { SuggestionItem } from "../suggest/index.js";
import { FIELD_ROW_HEIGHT, HEADER_HEIGHT, NODE_WIDTH } from "./constants.js";

/**
 * Resolves an active suggestion to the geometry needed to preview it on the canvas — ring rects
 * and (for relationships) a ghost-edge path — all in React Flow **flow coordinates**, derived
 * analytically from the live table positions in the store plus the fixed row layout. The overlay
 * projects these to screen space with the current viewport, so they track pan/zoom. Returns null
 * when the suggestion's tables/fields aren't on the canvas (nothing to highlight).
 */

export type PreviewTone = "accent" | "warn";

export type PreviewRing = { x: number; y: number; w: number; h: number };
export type PreviewAnchor = { x: number; y: number; side: "left" | "right" };
export type PreviewEdge = { from: PreviewAnchor; to: PreviewAnchor };

export type SuggestionPreview = {
  tone: PreviewTone;
  rings: PreviewRing[];
  edge: PreviewEdge | null;
  caption: { badge: string; title: string; stat: string };
};

type FieldLocation = { table: Table; rowIndex: number };

const nameEq = (a: string, b: string) => a.toLowerCase() === b.toLowerCase();

/** Find a field on a named table. */
function locate(schema: Schema, tableName: string, fieldName: string): FieldLocation | null {
  const table = schema.tables.find((candidate) => nameEq(candidate.name, tableName));
  if (!table) {
    return null;
  }
  const rowIndex = table.fields.findIndex((field) => nameEq(field.name, fieldName));
  return rowIndex < 0 ? null : { table, rowIndex };
}

/** Find a field by name across tables, preferring one whose name matches a source-derived hint. */
function locateByField(schema: Schema, fieldName: string, hint: string): FieldLocation | null {
  const matches = schema.tables.filter((table) =>
    table.fields.some((field) => nameEq(field.name, fieldName)),
  );
  if (matches.length === 0) {
    return null;
  }
  const base = tableNameFromFilename(hint).toLowerCase();
  const table =
    matches.find((candidate) => candidate.name.toLowerCase() === base) ??
    matches.find((candidate) => candidate.name.toLowerCase().startsWith(base)) ??
    matches[0]!;
  const rowIndex = table.fields.findIndex((field) => nameEq(field.name, fieldName));
  return { table, rowIndex };
}

function rowTop(loc: FieldLocation): number {
  return loc.table.y + HEADER_HEIGHT + loc.rowIndex * FIELD_ROW_HEIGHT;
}

/** A rectangle hugging a field row, inset ~3px outside it. */
function ringForRow(loc: FieldLocation): PreviewRing {
  return { x: loc.table.x - 3, y: rowTop(loc) - 3, w: NODE_WIDTH + 6, h: FIELD_ROW_HEIGHT + 6 };
}

/** A rectangle hugging an entire table (used by the dormant composite-key caution preview). */
function ringForTable(table: Table): PreviewRing {
  const height = HEADER_HEIGHT + table.fields.length * FIELD_ROW_HEIGHT;
  return { x: table.x - 3, y: table.y - 3, w: NODE_WIDTH + 6, h: height + 6 };
}

function anchor(loc: FieldLocation, side: "left" | "right"): PreviewAnchor {
  const y = rowTop(loc) + FIELD_ROW_HEIGHT / 2;
  const x = side === "left" ? loc.table.x : loc.table.x + NODE_WIDTH;
  return { x, y, side };
}

/** Anchor the ghost edge on whichever sides face each other, given the tables' horizontal order. */
function edgeBetween(from: FieldLocation, to: FieldLocation): PreviewEdge {
  const fromLeftOfTo = from.table.x <= to.table.x;
  return {
    from: anchor(from, fromLeftOfTo ? "right" : "left"),
    to: anchor(to, fromLeftOfTo ? "left" : "right"),
  };
}

export function buildSuggestionPreview(
  item: SuggestionItem,
  schema: Schema,
): SuggestionPreview | null {
  if (item.group === "pk") {
    const loc = locate(schema, item.key.tableName, item.key.candidate.field);
    if (!loc) {
      return null;
    }
    return {
      tone: "accent",
      rings: [ringForRow(loc)],
      edge: null,
      caption: {
        badge: "Primary key",
        title: `${item.key.tableName}.${item.key.candidate.field}`,
        stat: item.key.reason,
      },
    };
  }

  if (item.group === "type") {
    const loc = locate(schema, item.type.tableName, item.type.field);
    if (!loc) {
      return null;
    }
    return {
      tone: "accent",
      rings: [ringForRow(loc)],
      edge: null,
      caption: {
        badge: "Type",
        title: `${item.type.tableName}.${item.type.field} → ${item.type.suggestedType}`,
        stat: item.type.reason,
      },
    };
  }

  // Foreign key / relationship / join.
  const { candidate } = item.join;
  const left = locateByField(schema, candidate.left.field, candidate.left.sourceName);
  const right = locateByField(schema, candidate.right.field, candidate.right.sourceName);
  if (!left || !right) {
    return null;
  }

  const isManyToMany = item.join.grainLabel === "N:M";
  const grain = item.join.grainLabel ? ` · grain ${item.join.grainLabel}` : "";
  return {
    tone: "accent",
    rings: [ringForRow(left), ringForRow(right)],
    edge: edgeBetween(left, right),
    caption: {
      badge: isManyToMany ? "Relationship" : "Foreign key",
      title: `${left.table.name}.${candidate.left.field} → ${right.table.name}.${candidate.right.field}`,
      stat: `${item.join.overlapPercent}% value overlap · ${item.join.sharedValues} shared${grain}`,
    },
  };
}

/** Exposed for a future composite-key caution preview (whole-table amber ring). Unused today. */
export function tableCautionPreview(table: Table, stat: string): SuggestionPreview {
  return {
    tone: "warn",
    rings: [ringForTable(table)],
    edge: null,
    caption: { badge: "Needs review", title: table.name, stat },
  };
}
