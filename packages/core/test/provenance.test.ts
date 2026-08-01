import { describe, expect, it } from "vitest";

import { applyActions, emptySchema } from "../src/index.js";
import type { Field, Relationship, Schema, Table } from "../src/model.js";

function makeTestIds() {
  let counter = 0;
  return () => `id-${++counter}`;
}

function table(schema: Schema, name: string): Table {
  const found = schema.tables.find((candidate) => candidate.name === name);
  if (!found) {
    throw new Error(`table '${name}' not found`);
  }
  return found;
}

function field(schema: Schema, tableName: string, fieldName: string): Field {
  const found = table(schema, tableName).fields.find((candidate) => candidate.name === fieldName);
  if (!found) {
    throw new Error(`field '${fieldName}' not found in '${tableName}'`);
  }
  return found;
}

function onlyRelationship(schema: Schema): Relationship {
  const [first] = schema.relationships;
  if (!first) {
    throw new Error("schema has no relationships");
  }
  return first;
}

/** An `orders` + `customers` pair linked on customer_id, all created by `actor`. */
function seed(actor: "ai" | "user"): Schema {
  const makeId = makeTestIds();
  const { schema } = applyActions(
    emptySchema(),
    [
      {
        op: "add_table",
        name: "customers",
        fields: [{ name: "id", type: "integer", pk: true }],
      },
      {
        op: "add_table",
        name: "orders",
        fields: [
          { name: "id", type: "integer", pk: true },
          { name: "customer_id", type: "integer" },
        ],
      },
      {
        op: "add_relationship",
        from_table: "orders",
        from_field: "customer_id",
        to_table: "customers",
        to_field: "id",
      },
    ],
    { makeId, actor },
  );
  return schema;
}

describe("provenance", () => {
  describe("stamping on create", () => {
    it("stamps the actor on tables, their fields, and relationships", () => {
      const schema = seed("ai");

      expect(table(schema, "orders").provenance).toEqual({ origin: "ai", touched: false });
      expect(field(schema, "orders", "customer_id").provenance).toEqual({
        origin: "ai",
        touched: false,
      });
      expect(onlyRelationship(schema).provenance).toEqual({ origin: "ai", touched: false });
    });

    it("defaults to the user when no actor is given", () => {
      const makeId = makeTestIds();
      const { schema } = applyActions(emptySchema(), [{ op: "add_table", name: "orders" }], {
        makeId,
      });

      expect(table(schema, "orders").provenance).toEqual({ origin: "user", touched: false });
    });

    it("stamps a field added to an AI table with the actor who added it", () => {
      const makeId = makeTestIds();
      const { schema } = applyActions(
        seed("ai"),
        [{ op: "add_field", table: "orders", name: "note", type: "text" }],
        { makeId, actor: "user" },
      );

      // The table keeps its AI origin — provenance covers each entity's own attributes, so one
      // hand-added field must not rewrite the table or its siblings.
      expect(table(schema, "orders").provenance?.origin).toBe("ai");
      expect(field(schema, "orders", "note").provenance?.origin).toBe("user");
      expect(field(schema, "orders", "customer_id").provenance).toEqual({
        origin: "ai",
        touched: false,
      });
    });

    it("stamps nothing when the action is rejected", () => {
      const makeId = makeTestIds();
      const before = seed("user");
      const { schema, rejected } = applyActions(before, [{ op: "add_table", name: "orders" }], {
        makeId,
        actor: "ai",
      });

      expect(rejected).toHaveLength(1);
      expect(schema.tables).toHaveLength(2);
      expect(table(schema, "orders").provenance?.origin).toBe("user");
    });
  });

  describe("touched transitions", () => {
    const mutations: Array<{ op: string; action: Record<string, unknown> }> = [
      {
        op: "rename_field",
        action: { op: "rename_field", table: "orders", field: "customer_id", new_name: "cust_id" },
      },
      {
        op: "set_type",
        action: { op: "set_type", table: "orders", field: "customer_id", type: "text" },
      },
      {
        op: "set_pk",
        action: { op: "set_pk", table: "orders", field: "customer_id", pk: true },
      },
    ];

    for (const { op, action } of mutations) {
      it(`marks a field touched when the user applies ${op} to an AI field`, () => {
        const makeId = makeTestIds();
        const { schema } = applyActions(seed("ai"), [action], { makeId, actor: "user" });
        const target = table(schema, "orders").fields.find(
          (candidate) => candidate.name === "cust_id" || candidate.name === "customer_id",
        );

        expect(target?.provenance).toMatchObject({ origin: "ai", touched: true });
      });

      it(`leaves a field untouched when the AI applies ${op} to its own field`, () => {
        const makeId = makeTestIds();
        const { schema } = applyActions(seed("ai"), [action], { makeId, actor: "ai" });
        const target = table(schema, "orders").fields.find(
          (candidate) => candidate.name === "cust_id" || candidate.name === "customer_id",
        );

        expect(target?.provenance).toMatchObject({ origin: "ai", touched: false });
      });
    }

    it("marks a table touched when the user renames an AI table", () => {
      const makeId = makeTestIds();
      const { schema } = applyActions(
        seed("ai"),
        [{ op: "rename_table", table: "orders", new_name: "purchases" }],
        { makeId, actor: "user" },
      );

      expect(table(schema, "purchases").provenance).toMatchObject({ origin: "ai", touched: true });
      // A rename touches the name, not the columns.
      expect(field(schema, "purchases", "customer_id").provenance?.touched).toBe(false);
    });

    it("marks a relationship touched when the user changes an AI cardinality", () => {
      const makeId = makeTestIds();
      const { schema } = applyActions(
        seed("ai"),
        [
          {
            op: "set_cardinality",
            from_table: "orders",
            from_field: "customer_id",
            to_table: "customers",
            to_field: "id",
            cardinality: "1:1",
          },
        ],
        { makeId, actor: "user" },
      );

      expect(onlyRelationship(schema).provenance).toMatchObject({ origin: "ai", touched: true });
    });

    it("stays touched once set, even if the AI edits it again afterwards", () => {
      const makeId = makeTestIds();
      const { schema: edited } = applyActions(
        seed("ai"),
        [{ op: "set_type", table: "orders", field: "customer_id", type: "text" }],
        { makeId, actor: "user" },
      );
      const { schema } = applyActions(
        edited,
        [{ op: "set_type", table: "orders", field: "customer_id", type: "bigint" }],
        { makeId, actor: "ai" },
      );

      expect(field(schema, "orders", "customer_id").provenance).toMatchObject({ touched: true });
    });

    it("leaves entities without provenance alone rather than inventing an origin", () => {
      const makeId = makeTestIds();
      const legacy: Schema = {
        tables: [
          {
            id: "t1",
            name: "orders",
            x: 0,
            y: 0,
            fields: [{ id: "f1", name: "id", type: "integer", pk: true, fk: false }],
          },
        ],
        relationships: [],
      };
      const { schema } = applyActions(
        legacy,
        [{ op: "set_type", table: "orders", field: "id", type: "bigint" }],
        { makeId, actor: "ai" },
      );

      expect(field(schema, "orders", "id").provenance).toBeUndefined();
    });
  });

  describe("removal", () => {
    it("drops provenance with the field, including cascaded relationships", () => {
      const makeId = makeTestIds();
      const { schema } = applyActions(
        seed("ai"),
        [{ op: "remove_field", table: "orders", field: "customer_id" }],
        { makeId, actor: "user" },
      );

      expect(
        table(schema, "orders").fields.some((candidate) => candidate.name === "customer_id"),
      ).toBe(false);
      expect(schema.relationships).toHaveLength(0);
    });

    it("drops provenance with the table", () => {
      const makeId = makeTestIds();
      const { schema } = applyActions(seed("ai"), [{ op: "remove_table", table: "orders" }], {
        makeId,
        actor: "user",
      });

      expect(schema.tables.map((candidate) => candidate.name)).toEqual(["customers"]);
      expect(schema.relationships).toHaveLength(0);
    });
  });

  it("does not mutate the input schema", () => {
    const before = seed("ai");
    const snapshot = structuredClone(before);
    const makeId = makeTestIds();

    applyActions(before, [{ op: "rename_table", table: "orders", new_name: "purchases" }], {
      makeId,
      actor: "user",
    });

    expect(before).toEqual(snapshot);
  });
});
