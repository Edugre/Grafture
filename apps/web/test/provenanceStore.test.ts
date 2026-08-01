import { describe, expect, it } from "vitest";

import type { Schema, Source } from "@grafture/core";

import { buildTableFromSource } from "../src/sources/buildFromSource.js";
import { createSchemaStore } from "../src/store/schemaStore.js";

function makeTestIds(prefix = "id") {
  let counter = 0;
  return () => `${prefix}-${++counter}`;
}

function firstTable(schema: Schema) {
  const table = schema.tables[0];
  if (!table) {
    throw new Error("schema has no tables");
  }
  return table;
}

describe("provenance through the store", () => {
  describe("actor attribution", () => {
    it("defaults to the user for the typed UI commands", () => {
      const store = createSchemaStore({ makeId: makeTestIds() });

      store.getState().addTable("users");
      const table = firstTable(store.getState().schema);
      store.getState().addField(table.id, "email");

      expect(table.provenance?.origin).toBe("user");
      expect(firstTable(store.getState().schema).fields[0]?.provenance?.origin).toBe("user");
    });

    it("attributes an explicit ai actor, with the turn id, through runActions", () => {
      const store = createSchemaStore({ makeId: makeTestIds() });

      store.getState().runActions(
        [
          {
            op: "add_table",
            name: "orders",
            rationale: { text: "one row per order line in orders.csv" },
          },
        ],
        { actor: "ai", turnId: "turn-3" },
      );

      expect(firstTable(store.getState().schema).provenance).toEqual({
        origin: "ai",
        touched: false,
        rationale: {
          text: "one row per order line in orders.csv",
          evidence: [],
          turnId: "turn-3",
        },
      });
    });

    it("marks a copilot table touched once the user renames it", () => {
      const store = createSchemaStore({ makeId: makeTestIds() });

      store.getState().runActions([{ op: "add_table", name: "orders" }], { actor: "ai" });
      const table = firstTable(store.getState().schema);
      store.getState().renameTable(table.id, "purchases");

      expect(firstTable(store.getState().schema).provenance).toMatchObject({
        origin: "ai",
        touched: true,
      });
    });

    it("stamps a table built from a parsed file as imported", () => {
      const store = createSchemaStore({ makeId: makeTestIds() });
      const source: Source = {
        id: "src-1",
        name: "employees.csv",
        kind: "csv",
        fields: [
          { name: "employee_id", type: "int", samples: ["1", "2"] },
          { name: "email", type: "text", samples: ["a@b.c"] },
        ],
      };

      buildTableFromSource(store.getState().runActions, store.getState().schema, source);

      const table = firstTable(store.getState().schema);
      expect(table.provenance?.origin).toBe("imported");
      expect(table.fields.every((field) => field.provenance?.origin === "imported")).toBe(true);
    });
  });

  describe("history", () => {
    it("restores provenance and rationale on undo", () => {
      const store = createSchemaStore({ makeId: makeTestIds() });

      store.getState().runActions(
        [
          {
            op: "add_table",
            name: "orders",
            fields: [{ name: "id", type: "integer", pk: true }],
            rationale: { text: "orders.csv is one row per order" },
          },
        ],
        { actor: "ai", turnId: "turn-1" },
      );
      const table = firstTable(store.getState().schema);

      store.getState().renameTable(table.id, "purchases");
      expect(firstTable(store.getState().schema).provenance?.touched).toBe(true);

      store.getState().undo();

      const restored = firstTable(store.getState().schema);
      expect(restored.name).toBe("orders");
      expect(restored.provenance).toEqual({
        origin: "ai",
        touched: false,
        rationale: { text: "orders.csv is one row per order", evidence: [], turnId: "turn-1" },
      });
    });

    it("reapplies the touched transition on redo", () => {
      const store = createSchemaStore({ makeId: makeTestIds() });

      store.getState().runActions([{ op: "add_table", name: "orders" }], { actor: "ai" });
      const table = firstTable(store.getState().schema);
      store.getState().renameTable(table.id, "purchases");
      store.getState().undo();
      store.getState().redo();

      expect(firstTable(store.getState().schema)).toMatchObject({
        name: "purchases",
        provenance: { origin: "ai", touched: true },
      });
    });
  });

  describe("draft", () => {
    it("preserves provenance through setDraft and acceptDraft", () => {
      const store = createSchemaStore({ makeId: makeTestIds() });

      store.getState().runActions(
        [
          {
            op: "add_table",
            name: "orders",
            rationale: { text: "grain is one row per order" },
          },
        ],
        { actor: "ai", turnId: "turn-9" },
      );
      const proposed = store.getState().schema;

      // Reset the live schema so acceptDraft is a real swap rather than a no-op.
      store.getState().loadProject({ tables: [], relationships: [] }, []);
      store.getState().setDraft(proposed);

      const accepted = store.getState().acceptDraft();
      expect(accepted.ok).toBe(true);

      // SchemaSchema.safeParse runs over the draft before the swap — provenance must survive it.
      expect(firstTable(store.getState().schema).provenance).toEqual({
        origin: "ai",
        touched: false,
        rationale: { text: "grain is one row per order", evidence: [], turnId: "turn-9" },
      });
    });
  });
});
