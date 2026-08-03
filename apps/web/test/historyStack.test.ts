import { describe, expect, it } from "vitest";

import type { Source } from "@grafture/core";

import { matchHistoryShortcut } from "../src/history/shortcuts.js";
import { describeChange } from "../src/store/changeLabel.js";
import { createSchemaStore } from "../src/store/schemaStore.js";

function makeTestIds(prefix = "id") {
  let counter = 0;
  return () => `${prefix}-${++counter}`;
}

function sampleSource(id: string, name: string): Source {
  return {
    id,
    name,
    kind: "csv",
    fields: [{ name: "employee_id", type: "int", samples: ["1", "2"] }],
  };
}

/** Add `users(id)` and return the store, with the ids the test needs. */
function storeWithUsers() {
  const store = createSchemaStore({ makeId: makeTestIds() });
  store.getState().addTable("users");
  const tableId = store.getState().schema.tables[0]!.id;
  store.getState().addField(tableId, "id");
  const fieldId = store.getState().schema.tables[0]!.fields[0]!.id;
  return { store, tableId, fieldId };
}

describe("labelled history", () => {
  describe("describeChange", () => {
    it("names a removal from the pre-change schema", () => {
      const before = {
        tables: [{ id: "t1", name: "orders", x: 0, y: 0, fields: [] }],
        relationships: [],
      };
      const after = { tables: [], relationships: [] };

      expect(describeChange(before, after, [{ op: "remove_table", tableIds: ["t1"] }])).toEqual({
        label: "Remove table orders",
        details: [],
      });
    });

    it("collapses a multi-action batch to a count, keeping a line per action", () => {
      const schema = {
        tables: [
          { id: "t1", name: "orders", x: 0, y: 0, fields: [] },
          { id: "t2", name: "customers", x: 0, y: 0, fields: [] },
        ],
        relationships: [],
      };
      const applied = [
        { op: "add_table", tableIds: ["t1"] },
        { op: "add_field", tableIds: ["t1"] },
        { op: "add_relationship", tableIds: ["t1", "t2"] },
      ];

      expect(describeChange(schema, schema, applied)).toEqual({
        label: "3 changes",
        details: ["Add table orders", "Add field to orders", "Link orders → customers"],
      });
    });

    it("counts only what applied, not what was requested", () => {
      const store = createSchemaStore({ makeId: makeTestIds() });

      // The second action names a table that does not exist; only the first lands.
      store.getState().runActions([
        { op: "add_table", name: "users" },
        { op: "add_field", table: "ghosts", name: "id", type: "text", pk: false, fk: false },
      ]);

      expect(store.getState().history.past.at(-1)?.label).toBe("Add table users");
      // One action survived, so the step needs no expansion.
      expect(store.getState().history.past.at(-1)?.details).toEqual([]);
    });
  });

  describe("step labels and actors", () => {
    it("labels a manual edit as the user's", () => {
      const { store, tableId } = storeWithUsers();

      store.getState().renameTable(tableId, "people");

      const step = store.getState().history.past.at(-1);
      expect(step?.label).toBe("Rename table people");
      expect(step?.actor).toBe("user");
    });

    it("attributes a copilot batch to the AI", () => {
      const store = createSchemaStore({ makeId: makeTestIds() });

      store
        .getState()
        .runActions([{ op: "add_table", name: "orders" }], { actor: "ai", turnId: "turn-1" });

      const step = store.getState().history.past.at(-1);
      expect(step?.label).toBe("Add table orders");
      expect(step?.actor).toBe("ai");
      expect(step?.details).toEqual([]);
    });

    it("keeps the per-action detail on a batched copilot turn", () => {
      const store = createSchemaStore({ makeId: makeTestIds() });

      store.getState().runActions(
        [
          { op: "add_table", name: "orders" },
          { op: "add_field", table: "orders", name: "id", type: "int", pk: true, fk: false },
        ],
        { actor: "ai", turnId: "turn-1" },
      );

      const step = store.getState().history.past.at(-1);
      expect(step?.label).toBe("2 changes");
      expect(step?.details).toEqual(["Add table orders", "Add field to orders"]);
    });

    it("labels source and geometry steps", () => {
      const { store, tableId } = storeWithUsers();

      store.getState().addSource(sampleSource("s-1", "employees.csv"));
      expect(store.getState().history.past.at(-1)).toMatchObject({
        label: "Add source employees.csv",
        actor: "imported",
      });

      store.getState().moveTable(tableId, 40, 60);
      expect(store.getState().history.past.at(-1)?.label).toBe("Move users");

      store.getState().removeSource("s-1");
      expect(store.getState().history.past.at(-1)?.label).toBe("Remove source employees.csv");
    });

    it("keeps a coalesced drag as one labelled step", () => {
      const { store, tableId } = storeWithUsers();
      const depth = store.getState().history.past.length;

      store.getState().moveTable(tableId, 10, 10);
      store.getState().moveTable(tableId, 20, 20);
      store.getState().moveTable(tableId, 30, 30);

      expect(store.getState().history.past).toHaveLength(depth + 1);
      expect(store.getState().history.past.at(-1)?.label).toBe("Move users");
    });
  });

  describe("labels across undo/redo", () => {
    it("moves the label with its step and back again", () => {
      const { store, tableId } = storeWithUsers();
      store.getState().renameTable(tableId, "people");

      store.getState().undo();

      // The rename is now the next redo — the top of the future stack, still named.
      expect(store.getState().history.future.at(-1)?.label).toBe("Rename table people");
      expect(store.getState().history.past.at(-1)?.label).toBe("Add field to users");

      store.getState().redo();

      expect(store.getState().history.future).toHaveLength(0);
      expect(store.getState().history.past.at(-1)?.label).toBe("Rename table people");
    });
  });

  describe("travel", () => {
    it("walks back several steps and forward again", () => {
      const { store, tableId } = storeWithUsers();
      store.getState().addField(tableId, "email");
      store.getState().addField(tableId, "name");
      expect(store.getState().schema.tables[0]?.fields).toHaveLength(3);

      store.getState().travel(-2);

      expect(store.getState().schema.tables[0]?.fields).toHaveLength(1);
      expect(store.getState().history.future).toHaveLength(2);

      store.getState().travel(2);

      expect(store.getState().schema.tables[0]?.fields).toHaveLength(3);
      expect(store.getState().history.future).toHaveLength(0);
    });

    it("stops at the ends of the stack instead of throwing", () => {
      const { store } = storeWithUsers();

      store.getState().travel(-50);
      expect(store.getState().schema.tables).toHaveLength(0);
      expect(store.getState().canUndo()).toBe(false);

      store.getState().travel(50);
      expect(store.getState().schema.tables[0]?.fields).toHaveLength(1);
      expect(store.getState().canRedo()).toBe(false);
    });

    it("is a no-op at offset 0", () => {
      const { store } = storeWithUsers();
      const depth = store.getState().history.past.length;

      store.getState().travel(0);

      expect(store.getState().history.past).toHaveLength(depth);
      expect(store.getState().history.future).toHaveLength(0);
    });
  });
});

describe("keyboard shortcuts", () => {
  const event = (over: Partial<Parameters<typeof matchHistoryShortcut>[0]>) => ({
    key: "z",
    metaKey: false,
    ctrlKey: false,
    shiftKey: false,
    altKey: false,
    ...over,
  });

  it("reads both the Cmd and Ctrl spellings", () => {
    expect(matchHistoryShortcut(event({ metaKey: true }))).toBe("undo");
    expect(matchHistoryShortcut(event({ ctrlKey: true }))).toBe("undo");
    expect(matchHistoryShortcut(event({ metaKey: true, shiftKey: true }))).toBe("redo");
    expect(matchHistoryShortcut(event({ ctrlKey: true, shiftKey: true }))).toBe("redo");
    expect(matchHistoryShortcut(event({ key: "y", ctrlKey: true }))).toBe("redo");
  });

  it("is case-insensitive — Shift+Z reports an uppercase key", () => {
    expect(matchHistoryShortcut(event({ key: "Z", metaKey: true, shiftKey: true }))).toBe("redo");
  });

  it("ignores anything that is not the shortcut", () => {
    expect(matchHistoryShortcut(event({}))).toBeNull();
    expect(matchHistoryShortcut(event({ key: "a", metaKey: true }))).toBeNull();
    // Cmd+Y is not redo anywhere; only the Ctrl spelling is.
    expect(matchHistoryShortcut(event({ key: "y", metaKey: true }))).toBeNull();
    // Alt is a different chord (⌥⌘Z is not ours), so it never matches.
    expect(matchHistoryShortcut(event({ metaKey: true, altKey: true }))).toBeNull();
  });
});
