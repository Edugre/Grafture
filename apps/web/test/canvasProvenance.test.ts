import type { Field, Provenance, Table } from "@grafture/core";
import { describe, expect, it } from "vitest";

import {
  isStaleRationale,
  isTouched,
  originOf,
  provenanceLabel,
  resolveRationale,
  tableOrigin,
} from "../src/canvas/provenance.js";
import { createSchemaStore } from "../src/store/schemaStore.js";

function makeTestIds(prefix = "id") {
  let counter = 0;
  return () => `${prefix}-${++counter}`;
}

function field(name: string, provenance?: Provenance): Field {
  return {
    id: name,
    name,
    type: "text",
    pk: false,
    fk: false,
    ...(provenance === undefined ? {} : { provenance }),
  };
}

function table(fields: Field[], provenance?: Provenance): Table {
  return {
    id: "t1",
    name: "orders",
    x: 0,
    y: 0,
    fields,
    ...(provenance === undefined ? {} : { provenance }),
  };
}

const ai: Provenance = { origin: "ai", touched: false };
const user: Provenance = { origin: "user", touched: false };
const imported: Provenance = { origin: "imported", touched: false };

describe("canvas provenance helpers", () => {
  describe("originOf", () => {
    it("reads absent provenance as user", () => {
      expect(originOf(field("id"))).toBe("user");
    });

    it("reads the recorded origin", () => {
      expect(originOf(field("id", ai))).toBe("ai");
    });
  });

  describe("tableOrigin", () => {
    it("is the shared origin when the table and every field agree", () => {
      expect(tableOrigin(table([field("a", ai), field("b", ai)], ai))).toBe("ai");
      expect(tableOrigin(table([field("a", imported)], imported))).toBe("imported");
    });

    it("is mixed when the copilot adds a field to a hand-built table", () => {
      expect(tableOrigin(table([field("a", user), field("b", ai)], user))).toBe("mixed");
    });

    it("is mixed when the table name and its fields disagree", () => {
      expect(tableOrigin(table([field("a", ai)], user))).toBe("mixed");
    });

    it("treats an unstamped legacy table as user rather than mixed", () => {
      expect(tableOrigin(table([field("a"), field("b")]))).toBe("user");
    });
  });

  describe("staleness", () => {
    it("is stale only when a rationale exists and the entity was touched", () => {
      const explained: Provenance = {
        origin: "ai",
        touched: false,
        rationale: { text: "x", evidence: [] },
      };
      const edited: Provenance = {
        origin: "ai",
        touched: true,
        rationale: { text: "x", evidence: [] },
      };

      expect(isStaleRationale(field("a", explained))).toBe(false);
      expect(isStaleRationale(field("a", edited))).toBe(true);
      // Touched but never explained: nothing to go stale.
      expect(isStaleRationale(field("a", { origin: "ai", touched: true }))).toBe(false);
      expect(isTouched(field("a", { origin: "ai", touched: true }))).toBe(true);
    });
  });

  describe("provenanceLabel", () => {
    it("states the origin in words, so hue is never the only channel", () => {
      expect(provenanceLabel("ai")).toBe("Created by the AI copilot");
      expect(provenanceLabel("imported")).toBe("Created by an imported file");
      expect(provenanceLabel("mixed")).toBe("Created by several sources");
    });

    it("appends the edited-since qualifier when touched", () => {
      expect(provenanceLabel("ai", { touched: true })).toBe(
        "Created by the AI copilot, edited since",
      );
    });
  });
});

describe("review mode", () => {
  it("is off by default", () => {
    expect(createSchemaStore().getState().reviewMode).toBe(false);
  });

  it("toggles without touching undo history", () => {
    const store = createSchemaStore();

    store.getState().addTable("orders");
    store.getState().setReviewMode(true);

    expect(store.getState().reviewMode).toBe(true);
    // Undo must walk back the table, not the view toggle.
    store.getState().undo();
    expect(store.getState().schema.tables).toHaveLength(0);
    expect(store.getState().reviewMode).toBe(true);
  });
});

describe("resolveRationale", () => {
  function seeded() {
    const store = createSchemaStore({ makeId: makeTestIds("r") });
    store.getState().runActions(
      [
        {
          rationale: { text: "one row per customer", evidence: ["detector:pk customers.id"] },
          op: "add_table",
          name: "customers",
          fields: [{ name: "id", type: "integer", pk: true }],
        },
        { op: "add_table", name: "orders", fields: [{ name: "customer_id", type: "integer" }] },
        {
          rationale: { text: "98% containment", evidence: ["probe_join:orders~customers"] },
          op: "add_relationship",
          from_table: "orders",
          from_field: "customer_id",
          to_table: "customers",
          to_field: "id",
        },
        {
          rationale: { text: "distinct and never empty" },
          op: "set_pk",
          table: "orders",
          field: "customer_id",
          pk: true,
        },
      ],
      { actor: "ai", turnId: "turn-1" },
    );
    return store;
  }

  it("returns null for no focus", () => {
    expect(resolveRationale(seeded().getState().schema, null)).toBeNull();
  });

  it("resolves a table rationale with its subject", () => {
    const schema = seeded().getState().schema;
    const table = schema.tables.find((t) => t.name === "customers")!;

    expect(resolveRationale(schema, { kind: "table", tableId: table.id })).toMatchObject({
      subject: "customers",
      kind: "table",
      origin: "ai",
      stale: false,
      rationale: { text: "one row per customer" },
    });
  });

  it("resolves a field rationale as table.field", () => {
    const schema = seeded().getState().schema;
    const table = schema.tables.find((t) => t.name === "orders")!;
    const field = table.fields[0]!;

    expect(
      resolveRationale(schema, { kind: "field", tableId: table.id, fieldId: field.id }),
    ).toMatchObject({ subject: "orders.customer_id", kind: "field" });
  });

  it("resolves a relationship rationale as both endpoints", () => {
    const schema = seeded().getState().schema;
    const relationship = schema.relationships[0]!;

    expect(
      resolveRationale(schema, { kind: "relationship", relationshipId: relationship.id }),
    ).toMatchObject({
      subject: "orders.customer_id → customers.id",
      kind: "relationship",
      rationale: { evidence: ["probe_join:orders~customers"] },
    });
  });

  it("reports stale the moment the user edits what it explains", () => {
    const store = seeded();
    const table = store.getState().schema.tables.find((t) => t.name === "customers")!;
    const focus = { kind: "table" as const, tableId: table.id };

    expect(resolveRationale(store.getState().schema, focus)?.stale).toBe(false);

    store.getState().renameTable(table.id, "clients");

    // Resolved live from the store, so an open panel flips to stale rather than showing the
    // state it was opened in.
    const after = resolveRationale(store.getState().schema, focus);
    expect(after?.stale).toBe(true);
    expect(after?.subject).toBe("clients");
  });

  it("returns null once the entity is gone, so a dangling focus can be cleared", () => {
    const store = seeded();
    const table = store.getState().schema.tables.find((t) => t.name === "customers")!;
    const focus = { kind: "table" as const, tableId: table.id };

    store.getState().removeTable(table.id);

    expect(resolveRationale(store.getState().schema, focus)).toBeNull();
  });

  it("returns null for an entity that has provenance but no rationale", () => {
    const store = seeded();
    const table = store.getState().schema.tables.find((t) => t.name === "orders")!;

    expect(
      resolveRationale(store.getState().schema, { kind: "table", tableId: table.id }),
    ).toBeNull();
  });
});

describe("rationale focus", () => {
  it("starts closed and opens to the focused entity", () => {
    const store = createSchemaStore({ makeId: makeTestIds("f") });
    expect(store.getState().rationaleFocus).toBeNull();

    store.getState().focusRationale({ kind: "table", tableId: "t1" });
    expect(store.getState().rationaleFocus).toEqual({ kind: "table", tableId: "t1" });
  });

  it("closes when review mode is switched off, since its markers are gone too", () => {
    const store = createSchemaStore({ makeId: makeTestIds("f") });
    store.getState().setReviewMode(true);
    store.getState().focusRationale({ kind: "table", tableId: "t1" });

    store.getState().setReviewMode(false);

    expect(store.getState().rationaleFocus).toBeNull();
  });

  it("clears review state when another project is loaded", () => {
    const store = createSchemaStore({ makeId: makeTestIds("f") });
    store.getState().setReviewMode(true);
    store.getState().focusRationale({ kind: "table", tableId: "t1" });

    store.getState().loadProject({ tables: [], relationships: [] }, []);

    expect(store.getState().reviewMode).toBe(false);
    expect(store.getState().rationaleFocus).toBeNull();
  });
});
