import type { Field, Provenance, Table } from "@grafture/core";
import { describe, expect, it } from "vitest";

import {
  isStaleRationale,
  isTouched,
  originOf,
  provenanceLabel,
  tableOrigin,
} from "../src/canvas/provenance.js";
import { createSchemaStore } from "../src/store/schemaStore.js";

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
