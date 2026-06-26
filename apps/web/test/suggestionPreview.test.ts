import type { Schema } from "@schema-studio/core";
import { describe, expect, it } from "vitest";

import { FIELD_ROW_HEIGHT, HEADER_HEIGHT, NODE_WIDTH } from "../src/canvas/constants.js";
import { buildSuggestionPreview } from "../src/canvas/suggestionPreview.js";
import type { SuggestionItem } from "../src/suggest/index.js";

/** Two tables; `org_id` appears in both (the ambiguous FK case the resolver must disambiguate). */
function schema(): Schema {
  return {
    tables: [
      {
        id: "t1",
        name: "organizations",
        x: 100,
        y: 50,
        fields: [
          { id: "f1", name: "org_id", type: "int", pk: false, fk: false },
          { id: "f2", name: "name", type: "text", pk: false, fk: false },
        ],
      },
      {
        id: "t2",
        name: "covered_entities",
        x: 500,
        y: 300,
        fields: [
          { id: "f3", name: "id", type: "int", pk: false, fk: false },
          { id: "f4", name: "org_id", type: "int", pk: false, fk: false },
        ],
      },
    ],
    relationships: [],
  };
}

const pkItem = {
  id: "pk1",
  group: "pk",
  needsReview: false,
  key: {
    id: "pk1",
    candidate: { field: "org_id" },
    label: "organizations · org_id",
    reason: "100% unique · no nulls",
    tableName: "organizations",
  },
} as unknown as SuggestionItem;

const fkItem = {
  id: "fk1",
  group: "fk",
  needsReview: false,
  join: {
    candidate: {
      left: { field: "org_id", sourceName: "covered_entities.csv" },
      right: { field: "org_id", sourceName: "organizations.csv" },
    },
    leftLabel: "covered_entities · org_id",
    rightLabel: "organizations · org_id",
    overlapPercent: 98,
    sharedValues: 1200,
    grainLabel: "N:1",
    warning: null,
  },
} as unknown as SuggestionItem;

describe("buildSuggestionPreview", () => {
  it("rings the exact PK row (3px outside, no edge)", () => {
    const preview = buildSuggestionPreview(pkItem, schema());
    expect(preview).not.toBeNull();
    expect(preview!.edge).toBeNull();
    expect(preview!.rings).toEqual([
      // org_id is row 0 of organizations at (100,50): top = 50 + 40 + 0.
      { x: 100 - 3, y: 50 + HEADER_HEIGHT - 3, w: NODE_WIDTH + 6, h: FIELD_ROW_HEIGHT + 6 },
    ]);
    expect(preview!.caption.badge).toBe("Primary key");
  });

  it("rings both FK endpoints and draws an edge, disambiguating the shared column by source", () => {
    const preview = buildSuggestionPreview(fkItem, schema());
    expect(preview).not.toBeNull();
    expect(preview!.rings).toHaveLength(2);
    expect(preview!.edge).not.toBeNull();
    // covered_entities.org_id is row 1 of the table at (500,300): top = 300 + 40 + 30.
    expect(preview!.rings[0]).toEqual({
      x: 500 - 3,
      y: 300 + HEADER_HEIGHT + FIELD_ROW_HEIGHT - 3,
      w: NODE_WIDTH + 6,
      h: FIELD_ROW_HEIGHT + 6,
    });
    // covered_entities (left, x=500) sits right of organizations, so anchor its left edge.
    expect(preview!.edge!.from.side).toBe("left");
    expect(preview!.edge!.to.side).toBe("right");
    expect(preview!.caption.badge).toBe("Foreign key");
  });

  it("returns null when the suggestion's table isn't on the canvas", () => {
    const missing = {
      id: "pk2",
      group: "pk",
      needsReview: false,
      key: {
        id: "pk2",
        candidate: { field: "org_id" },
        label: "ghost_table · org_id",
        reason: "",
        tableName: "ghost_table",
      },
    } as unknown as SuggestionItem;
    expect(buildSuggestionPreview(missing, schema())).toBeNull();
  });
});
