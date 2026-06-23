import { describe, expect, it } from "vitest";

import type { Source } from "@schema-studio/core";
import { emptySchema } from "@schema-studio/core";

import { createSchemaStore } from "../src/store/schemaStore.js";

function makeTestIds(prefix = "id") {
  let counter = 0;
  return () => `${prefix}-${++counter}`;
}

function sampleSource(id: string): Source {
  return {
    id,
    name: "employees.csv",
    kind: "csv",
    fields: [{ name: "employee_id", type: "int", samples: ["1", "2"] }],
  };
}

describe("schemaStore", () => {
  describe("runActions", () => {
    it("applies valid actions and updates schema", () => {
      const makeId = makeTestIds();
      const store = createSchemaStore({ makeId });

      const result = store.getState().runActions([{ op: "add_table", name: "users" }]);

      expect(result.rejected).toEqual([]);
      expect(result.applied).toEqual([{ op: "add_table", tableIds: ["id-1"] }]);
      expect(store.getState().schema.tables).toHaveLength(1);
      expect(store.getState().schema.tables[0]?.name).toBe("users");
    });

    it("surfaces rejected actions without mutating schema", () => {
      const makeId = makeTestIds();
      const store = createSchemaStore({ makeId });

      store.getState().runActions([{ op: "add_table", name: "users" }]);
      const before = structuredClone(store.getState().schema);

      const result = store.getState().runActions([{ op: "add_table", name: "Users" }]);

      expect(result.applied).toEqual([]);
      expect(result.rejected).toEqual([
        {
          action: { op: "add_table", name: "Users" },
          reason: "table 'Users' already exists",
        },
      ]);
      expect(store.getState().schema).toEqual(before);
    });

    it("applies partial batches and surfaces rejections for the rest", () => {
      const makeId = makeTestIds();
      const store = createSchemaStore({ makeId });

      store.getState().runActions([{ op: "add_table", name: "users" }]);

      const result = store.getState().runActions([
        { op: "add_table", name: "orders" },
        { op: "add_table", name: "users" },
      ]);

      expect(result.applied).toEqual([{ op: "add_table", tableIds: ["id-2"] }]);
      expect(result.rejected).toHaveLength(1);
      expect(result.rejected[0]?.reason).toBe("table 'users' already exists");
      expect(store.getState().schema.tables.map((table) => table.name)).toEqual([
        "users",
        "orders",
      ]);
    });

    it("rejects invalid action shapes", () => {
      const store = createSchemaStore({ makeId: makeTestIds() });

      const result = store.getState().runActions([{ op: "explode" }]);

      expect(result.applied).toEqual([]);
      expect(result.rejected.length).toBeGreaterThan(0);
      expect(store.getState().schema).toEqual(emptySchema());
    });
  });

  describe("manual commands", () => {
    it("routes renameTable through applyActions", () => {
      const makeId = makeTestIds();
      const store = createSchemaStore({ makeId });

      store.getState().addTable("users");
      const tableId = store.getState().schema.tables[0]?.id;
      expect(tableId).toBeDefined();

      const result = store.getState().renameTable(tableId!, "accounts");

      expect(result.rejected).toEqual([]);
      expect(store.getState().schema.tables[0]?.name).toBe("accounts");
    });

    it("toggles pk on a field", () => {
      const makeId = makeTestIds();
      const store = createSchemaStore({ makeId });

      store.getState().addTable("users");
      const tableId = store.getState().schema.tables[0]?.id;
      store.getState().addField(tableId!, "id", { pk: false });
      const fieldId = store.getState().schema.tables[0]?.fields[0]?.id;
      expect(fieldId).toBeDefined();

      const result = store.getState().togglePk(tableId!, fieldId!);

      expect(result.rejected).toEqual([]);
      expect(store.getState().schema.tables[0]?.fields[0]?.pk).toBe(true);
    });
  });

  describe("sources", () => {
    it("adds and removes sources", () => {
      const store = createSchemaStore({ makeId: makeTestIds() });
      const source = sampleSource("source-1");

      store.getState().addSource(source);
      expect(store.getState().sources).toEqual([source]);

      store.getState().removeSource("source-1");
      expect(store.getState().sources).toEqual([]);
    });
  });

  describe("undo and redo", () => {
    it("undoes and redoes schema mutations from runActions", () => {
      const store = createSchemaStore({ makeId: makeTestIds() });

      store.getState().runActions([{ op: "add_table", name: "users" }]);
      expect(store.getState().schema.tables).toHaveLength(1);
      expect(store.getState().canUndo()).toBe(true);

      store.getState().undo();
      expect(store.getState().schema.tables).toHaveLength(0);
      expect(store.getState().canRedo()).toBe(true);

      store.getState().redo();
      expect(store.getState().schema.tables).toHaveLength(1);
      expect(store.getState().schema.tables[0]?.name).toBe("users");
    });

    it("coalesces consecutive table drags into one undo step", () => {
      const makeId = makeTestIds();
      const store = createSchemaStore({ makeId });

      store.getState().addTable("users", { x: 0, y: 0 });
      const tableId = store.getState().schema.tables[0]?.id;
      expect(tableId).toBeDefined();

      store.getState().moveTable(tableId!, 40, 0);
      store.getState().moveTable(tableId!, 80, 0);
      store.getState().moveTable(tableId!, 120, 0);

      expect(store.getState().schema.tables[0]).toMatchObject({ x: 120, y: 0 });

      store.getState().undo();
      expect(store.getState().schema.tables[0]).toMatchObject({ x: 0, y: 0 });
    });

    it("starts a new undo step after a non-drag mutation", () => {
      const makeId = makeTestIds();
      const store = createSchemaStore({ makeId });

      store.getState().addTable("users", { x: 0, y: 0 });
      const tableId = store.getState().schema.tables[0]?.id;
      expect(tableId).toBeDefined();

      store.getState().moveTable(tableId!, 100, 0);
      store.getState().renameTable(tableId!, "accounts");
      store.getState().moveTable(tableId!, 200, 0);

      store.getState().undo();
      expect(store.getState().schema.tables[0]?.name).toBe("accounts");
      expect(store.getState().schema.tables[0]).toMatchObject({ x: 100, y: 0 });

      store.getState().undo();
      expect(store.getState().schema.tables[0]?.name).toBe("users");
      expect(store.getState().schema.tables[0]).toMatchObject({ x: 100, y: 0 });

      store.getState().undo();
      expect(store.getState().schema.tables[0]?.name).toBe("users");
      expect(store.getState().schema.tables[0]).toMatchObject({ x: 0, y: 0 });
    });

    it("applies a batched moveTables as a single undo step", () => {
      const makeId = makeTestIds();
      const store = createSchemaStore({ makeId });

      store.getState().addTable("users", { x: 0, y: 0 });
      store.getState().addTable("orders", { x: 0, y: 0 });
      const [users, orders] = store.getState().schema.tables;

      store.getState().moveTables([
        { tableId: users!.id, x: 100, y: 200 },
        { tableId: orders!.id, x: 300, y: 400 },
      ]);

      expect(store.getState().schema.tables[0]).toMatchObject({ x: 100, y: 200 });
      expect(store.getState().schema.tables[1]).toMatchObject({ x: 300, y: 400 });

      store.getState().undo();

      expect(store.getState().schema.tables[0]).toMatchObject({ x: 0, y: 0 });
      expect(store.getState().schema.tables[1]).toMatchObject({ x: 0, y: 0 });
    });

    it("undoes source changes", () => {
      const store = createSchemaStore({ makeId: makeTestIds() });
      const source = sampleSource("source-1");

      store.getState().addSource(source);
      store.getState().undo();

      expect(store.getState().sources).toEqual([]);
    });
  });
});
