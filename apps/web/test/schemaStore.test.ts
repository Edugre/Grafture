import { describe, expect, it } from "vitest";

import type { Source } from "@schema-studio/core";
import { emptySchema } from "@schema-studio/core";

import { createSchemaStore } from "../src/store/schemaStore.js";
import { HISTORY_LIMIT, createHistoryController, pushHistory } from "../src/store/history.js";

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

    it("renames a field as an undoable step", () => {
      const store = createSchemaStore({ makeId: makeTestIds() });
      store.getState().addTable("users");
      const tableId = store.getState().schema.tables[0]?.id;
      store.getState().addField(tableId!, "id");
      const fieldId = store.getState().schema.tables[0]?.fields[0]?.id;

      const result = store.getState().renameField(tableId!, fieldId!, "user_id");

      expect(result.rejected).toEqual([]);
      expect(store.getState().schema.tables[0]?.fields[0]?.name).toBe("user_id");

      store.getState().undo();
      expect(store.getState().schema.tables[0]?.fields[0]?.name).toBe("id");
    });

    it("rejects renaming a field to a duplicate name in the same table", () => {
      const store = createSchemaStore({ makeId: makeTestIds() });
      store.getState().addTable("users");
      const tableId = store.getState().schema.tables[0]?.id;
      store.getState().addField(tableId!, "id");
      store.getState().addField(tableId!, "email");
      const idField = store.getState().schema.tables[0]?.fields[0]?.id;

      const result = store.getState().renameField(tableId!, idField!, "Email");

      expect(result.applied).toEqual([]);
      expect(result.rejected).toHaveLength(1);
      expect(store.getState().schema.tables[0]?.fields[0]?.name).toBe("id");
    });

    it("sets a field type as an undoable step", () => {
      const store = createSchemaStore({ makeId: makeTestIds() });
      store.getState().addTable("users");
      const tableId = store.getState().schema.tables[0]?.id;
      store.getState().addField(tableId!, "id", { type: "text" });
      const fieldId = store.getState().schema.tables[0]?.fields[0]?.id;

      const result = store.getState().setFieldType(tableId!, fieldId!, "bigint");

      expect(result.rejected).toEqual([]);
      expect(store.getState().schema.tables[0]?.fields[0]?.type).toBe("bigint");

      store.getState().undo();
      expect(store.getState().schema.tables[0]?.fields[0]?.type).toBe("text");
    });

    it("toggles pk through the validated path as an undoable step", () => {
      const store = createSchemaStore({ makeId: makeTestIds() });
      store.getState().addTable("users");
      const tableId = store.getState().schema.tables[0]!.id;
      store.getState().addField(tableId, "id", { pk: false });
      const fieldId = store.getState().schema.tables[0]!.fields[0]!.id;

      const result = store.getState().togglePk(tableId, fieldId);
      expect(result.rejected).toEqual([]);
      expect(result.applied[0]).toMatchObject({ op: "set_pk", tableIds: [tableId] });
      expect(store.getState().schema.tables[0]!.fields[0]!.pk).toBe(true);

      store.getState().undo();
      expect(store.getState().schema.tables[0]!.fields[0]!.pk).toBe(false);
    });
  });

  describe("relationships", () => {
    // Seed users(id, pk) ← posts(author_id, fk) linked 1:N, returning the ids the store commands need.
    function seedLink(store: ReturnType<typeof createSchemaStore>) {
      store.getState().addTable("users");
      const usersId = store.getState().schema.tables[0]!.id;
      store.getState().addField(usersId, "id", { pk: true });
      const userIdField = store.getState().schema.tables[0]!.fields[0]!.id;

      store.getState().addTable("posts");
      const postsId = store.getState().schema.tables[1]!.id;
      store.getState().addField(postsId, "author_id", { fk: true });
      const authorIdField = store.getState().schema.tables[1]!.fields[0]!.id;

      store.getState().addRelationship(postsId, authorIdField, usersId, userIdField);
      const relationshipId = store.getState().schema.relationships[0]!.id;
      return { usersId, postsId, relationshipId };
    }

    it("adds then removes a relationship through applyActions, undoably", () => {
      const store = createSchemaStore({ makeId: makeTestIds() });
      const { relationshipId } = seedLink(store);
      expect(store.getState().schema.relationships).toHaveLength(1);

      const result = store.getState().removeRelationship(relationshipId);
      expect(result.rejected).toEqual([]);
      expect(result.applied[0]).toMatchObject({ op: "remove_relationship", relationshipId });
      expect(store.getState().schema.relationships).toHaveLength(0);

      store.getState().undo();
      expect(store.getState().schema.relationships).toHaveLength(1);
    });

    it("sets cardinality through applyActions, undoably", () => {
      const store = createSchemaStore({ makeId: makeTestIds() });
      const { relationshipId } = seedLink(store);
      expect(store.getState().schema.relationships[0]!.cardinality).toBe("1:N");

      const result = store.getState().setCardinality(relationshipId, "N:M");
      expect(result.rejected).toEqual([]);
      expect(result.applied[0]).toMatchObject({ op: "set_cardinality", relationshipId });
      expect(store.getState().schema.relationships[0]!.cardinality).toBe("N:M");

      store.getState().undo();
      expect(store.getState().schema.relationships[0]!.cardinality).toBe("1:N");
    });

    it("surfaces a rejection for an unknown relationship id without mutating schema", () => {
      const store = createSchemaStore({ makeId: makeTestIds() });
      seedLink(store);
      const before = structuredClone(store.getState().schema);

      const removed = store.getState().removeRelationship("nope");
      expect(removed.applied).toEqual([]);
      expect(removed.rejected[0]?.reason).toContain("not found");

      const carded = store.getState().setCardinality("nope", "1:1");
      expect(carded.applied).toEqual([]);
      expect(carded.rejected[0]?.reason).toContain("not found");

      expect(store.getState().schema).toEqual(before);
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

  describe("chat", () => {
    it("appends and clears chat messages", () => {
      const store = createSchemaStore({ makeId: makeTestIds() });

      store.getState().appendChatMessages([{ id: "m1", role: "user", text: "hi" }]);
      store.getState().appendChatMessages([{ id: "m2", role: "assistant", text: "hello" }]);
      expect(store.getState().chat.map((m) => m.id)).toEqual(["m1", "m2"]);

      store.getState().clearChat();
      expect(store.getState().chat).toEqual([]);
    });

    it("does not revert chat on undo", () => {
      const store = createSchemaStore({ makeId: makeTestIds() });

      store.getState().addTable("users");
      store.getState().appendChatMessages([{ id: "m1", role: "user", text: "add users" }]);

      store.getState().undo();

      // The schema edit is undone, but the conversation that produced it stays.
      expect(store.getState().schema.tables).toHaveLength(0);
      expect(store.getState().chat.map((m) => m.id)).toEqual(["m1"]);
    });
  });

  describe("undo and redo", () => {
    it("caps the undo stack at HISTORY_LIMIT, dropping the oldest snapshots", () => {
      const history = createHistoryController();
      const snapshot = (marker: number) => ({
        schema: { tables: [], relationships: [] },
        sources: [],
        selection: { tableId: `t-${marker}` },
      });

      for (let index = 0; index < HISTORY_LIMIT + 5; index += 1) {
        pushHistory(history, snapshot(index));
      }

      expect(history.past).toHaveLength(HISTORY_LIMIT);
      // The five oldest entries were dropped, not the newest.
      expect(history.past[0]?.selection.tableId).toBe("t-5");
      expect(history.past.at(-1)?.selection.tableId).toBe(`t-${HISTORY_LIMIT + 4}`);
    });

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

    it("coalesces consecutive table resizes into one undo step", () => {
      const store = createSchemaStore({ makeId: makeTestIds() });

      store.getState().addTable("users", { x: 0, y: 0 });
      const tableId = store.getState().schema.tables[0]?.id;
      expect(store.getState().schema.tables[0]?.width).toBeUndefined();

      store.getState().resizeTable(tableId!, 240);
      store.getState().resizeTable(tableId!, 280);
      store.getState().resizeTable(tableId!, 320);

      expect(store.getState().schema.tables[0]?.width).toBe(320);

      store.getState().undo();
      expect(store.getState().schema.tables[0]?.width).toBeUndefined();
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

  describe("loadProject", () => {
    it("replaces schema and sources and resets history", () => {
      const store = createSchemaStore({ makeId: makeTestIds() });
      store.getState().addTable("users");
      store.getState().addSource(sampleSource("source-1"));
      expect(store.getState().canUndo()).toBe(true);

      const nextSchema = emptySchema();
      nextSchema.tables.push({ id: "t-x", name: "orders", x: 5, y: 7, fields: [] });
      store.getState().appendChatMessages([{ id: "m0", role: "user", text: "old" }]);
      store
        .getState()
        .loadProject(
          nextSchema,
          [sampleSource("source-2")],
          [{ id: "m1", role: "user", text: "new project" }],
        );

      expect(store.getState().schema.tables.map((table) => table.name)).toEqual(["orders"]);
      expect(store.getState().sources.map((source) => source.id)).toEqual(["source-2"]);
      expect(store.getState().chat.map((m) => m.id)).toEqual(["m1"]);
      // Undo must not reach across the project boundary.
      expect(store.getState().canUndo()).toBe(false);
    });

    it("clones inputs so later edits to the source objects do not leak in", () => {
      const store = createSchemaStore({ makeId: makeTestIds() });
      const schema = emptySchema();
      schema.tables.push({ id: "t-x", name: "orders", x: 0, y: 0, fields: [] });

      store.getState().loadProject(schema, []);
      schema.tables[0]!.name = "mutated";

      expect(store.getState().schema.tables[0]?.name).toBe("orders");
    });
  });

  describe("draft (AI ghost proposal)", () => {
    const draftSchema = () => {
      const schema = emptySchema();
      schema.tables.push({ id: "d-1", name: "orders", x: 0, y: 0, fields: [] });
      return schema;
    };

    it("setDraft / discardDraft never touch the live schema or history", () => {
      const store = createSchemaStore({ makeId: makeTestIds() });

      store.getState().setDraft(draftSchema());
      expect(store.getState().draft?.tables[0]?.name).toBe("orders");
      expect(store.getState().schema.tables).toHaveLength(0);
      expect(store.getState().canUndo()).toBe(false);

      store.getState().discardDraft();
      expect(store.getState().draft).toBeNull();
      expect(store.getState().schema.tables).toHaveLength(0);
      expect(store.getState().canUndo()).toBe(false);
    });

    it("acceptDraft swaps the draft into the schema as one undoable step, then clears it", () => {
      const store = createSchemaStore({ makeId: makeTestIds() });

      store.getState().setDraft(draftSchema());
      store.getState().acceptDraft();

      expect(store.getState().draft).toBeNull();
      expect(store.getState().schema.tables.map((t) => t.name)).toEqual(["orders"]);
      expect(store.getState().canUndo()).toBe(true);

      store.getState().undo();
      expect(store.getState().schema.tables).toHaveLength(0);
    });

    it("acceptDraft is a no-op when there is no pending draft", () => {
      const store = createSchemaStore({ makeId: makeTestIds() });
      store.getState().acceptDraft();
      expect(store.getState().schema.tables).toHaveLength(0);
      expect(store.getState().canUndo()).toBe(false);
    });

    it("loadProject clears a pending draft", () => {
      const store = createSchemaStore({ makeId: makeTestIds() });
      store.getState().setDraft(draftSchema());

      store.getState().loadProject(emptySchema(), []);

      expect(store.getState().draft).toBeNull();
    });
  });
});
