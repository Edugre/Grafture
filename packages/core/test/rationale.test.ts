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

function seed(actor: "ai" | "user"): Schema {
  const makeId = makeTestIds();
  const { schema } = applyActions(
    emptySchema(),
    [
      { op: "add_table", name: "customers", fields: [{ name: "id", type: "integer", pk: true }] },
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

const link = {
  op: "add_relationship",
  from_table: "orders",
  from_field: "customer_id",
  to_table: "customers",
  to_field: "id",
  rationale: {
    text: "customer_id values are 98% contained in customers.id",
    evidence: ["join:orders.customer_id~customers.id"],
  },
};

describe("rationale", () => {
  describe("attachment", () => {
    it("attaches to a relationship the copilot creates", () => {
      const makeId = makeTestIds();
      const { schema } = applyActions(
        applyActions(
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
              fields: [{ name: "customer_id", type: "integer" }],
            },
          ],
          { makeId, actor: "ai" },
        ).schema,
        [link],
        { makeId, actor: "ai", turnId: "turn-7" },
      );

      expect(onlyRelationship(schema).provenance).toEqual({
        origin: "ai",
        touched: false,
        rationale: {
          text: "customer_id values are 98% contained in customers.id",
          evidence: ["join:orders.customer_id~customers.id"],
          turnId: "turn-7",
        },
      });
    });

    it("defaults evidence to an empty list and omits turnId when not supplied", () => {
      const makeId = makeTestIds();
      const { schema } = applyActions(
        emptySchema(),
        [
          {
            op: "add_table",
            name: "order_items",
            rationale: { text: "junction for an N:M grain" },
          },
        ],
        { makeId, actor: "ai" },
      );

      expect(table(schema, "order_items").provenance?.rationale).toEqual({
        text: "junction for an N:M grain",
        evidence: [],
      });
    });

    it("attaches on set_pk, set_type, and set_cardinality", () => {
      const makeId = makeTestIds();
      const { schema } = applyActions(
        seed("ai"),
        [
          {
            op: "set_pk",
            table: "orders",
            field: "customer_id",
            pk: true,
            rationale: { text: "unique across all sampled rows" },
          },
          {
            op: "set_type",
            table: "orders",
            field: "id",
            type: "bigint",
            rationale: { text: "max value exceeds int32" },
          },
          {
            op: "set_cardinality",
            from_table: "orders",
            from_field: "customer_id",
            to_table: "customers",
            to_field: "id",
            cardinality: "1:1",
            rationale: { text: "distinct count equals row count on both sides" },
          },
        ],
        { makeId, actor: "ai" },
      );

      expect(field(schema, "orders", "customer_id").provenance?.rationale?.text).toBe(
        "unique across all sampled rows",
      );
      expect(field(schema, "orders", "id").provenance?.rationale?.text).toBe(
        "max value exceeds int32",
      );
      expect(onlyRelationship(schema).provenance?.rationale?.text).toBe(
        "distinct count equals row count on both sides",
      );
    });

    it("rejects an empty rationale text rather than storing a blank explanation", () => {
      const makeId = makeTestIds();
      const { schema, rejected } = applyActions(
        emptySchema(),
        [{ op: "add_table", name: "orders", rationale: { text: "" } }],
        { makeId, actor: "ai" },
      );

      expect(rejected).toHaveLength(1);
      expect(schema.tables).toHaveLength(0);
    });
  });

  describe("actor gating", () => {
    it("drops a rationale supplied on a user action", () => {
      const makeId = makeTestIds();
      const { schema } = applyActions(
        emptySchema(),
        [{ op: "add_table", name: "orders", rationale: { text: "because I said so" } }],
        { makeId, actor: "user" },
      );

      expect(table(schema, "orders").provenance).toEqual({ origin: "user", touched: false });
    });

    it("keeps the action itself applied when the rationale is dropped", () => {
      const makeId = makeTestIds();
      const { schema, rejected } = applyActions(
        emptySchema(),
        [{ op: "add_table", name: "orders", rationale: { text: "because I said so" } }],
        { makeId, actor: "user" },
      );

      expect(rejected).toHaveLength(0);
      expect(schema.tables).toHaveLength(1);
    });
  });

  describe("staleness", () => {
    it("goes stale when the user edits the entity it explains", () => {
      const makeId = makeTestIds();
      const { schema: explained } = applyActions(
        seed("ai"),
        [
          {
            op: "set_cardinality",
            from_table: "orders",
            from_field: "customer_id",
            to_table: "customers",
            to_field: "id",
            cardinality: "1:N",
            rationale: { text: "customers repeat across orders" },
          },
        ],
        { makeId, actor: "ai" },
      );
      const { schema } = applyActions(
        explained,
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

      const provenance = onlyRelationship(schema).provenance;
      expect(provenance?.touched).toBe(true);
      // Retained, not deleted: the gap between the claim and the user's change is the point.
      expect(provenance?.rationale?.text).toBe("customers repeat across orders");
    });

    it("is current again when the copilot re-explains a user-edited entity", () => {
      const makeId = makeTestIds();
      const { schema: edited } = applyActions(
        seed("ai"),
        [{ op: "set_type", table: "orders", field: "customer_id", type: "text" }],
        { makeId, actor: "user" },
      );
      expect(field(edited, "orders", "customer_id").provenance?.touched).toBe(true);

      const { schema } = applyActions(
        edited,
        [
          {
            op: "set_type",
            table: "orders",
            field: "customer_id",
            type: "uuid",
            rationale: { text: "values are all 36-char hyphenated uuids" },
          },
        ],
        { makeId, actor: "ai" },
      );

      const provenance = field(schema, "orders", "customer_id").provenance;
      expect(provenance?.touched).toBe(false);
      expect(provenance?.rationale?.text).toBe("values are all 36-char hyphenated uuids");
    });

    it("replaces an earlier rationale rather than accumulating them", () => {
      const makeId = makeTestIds();
      const { schema: first } = applyActions(
        seed("ai"),
        [
          {
            op: "set_type",
            table: "orders",
            field: "id",
            type: "bigint",
            rationale: { text: "first read" },
          },
        ],
        { makeId, actor: "ai" },
      );
      const { schema } = applyActions(
        first,
        [
          {
            op: "set_type",
            table: "orders",
            field: "id",
            type: "text",
            rationale: { text: "second read, leading zeros matter" },
          },
        ],
        { makeId, actor: "ai" },
      );

      expect(field(schema, "orders", "id").provenance?.rationale).toEqual({
        text: "second read, leading zeros matter",
        evidence: [],
      });
    });

    it("materializes provenance on a legacy entity rather than dropping the rationale", () => {
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
        [
          {
            op: "set_type",
            table: "orders",
            field: "id",
            type: "bigint",
            rationale: { text: "max value exceeds int32" },
          },
        ],
        { makeId, actor: "ai" },
      );

      expect(field(schema, "orders", "id").provenance).toEqual({
        origin: "user",
        touched: false,
        rationale: { text: "max value exceeds int32", evidence: [] },
      });
    });
  });

  it("attaches nothing when the action is rejected", () => {
    const makeId = makeTestIds();
    const { schema, rejected } = applyActions(
      seed("ai"),
      [
        {
          op: "set_type",
          table: "orders",
          field: "nonexistent",
          type: "text",
          rationale: { text: "should never land" },
        },
      ],
      { makeId, actor: "ai" },
    );

    expect(rejected).toHaveLength(1);
    expect(
      table(schema, "orders").fields.every(
        (candidate) => candidate.provenance?.rationale === undefined,
      ),
    ).toBe(true);
  });
});

describe("rationale staleness is judged against the explanation, not the origin", () => {
  /**
   * Regression: found by running the app, not by the suite. The copilot can explain an entity it
   * did not create — a legacy or imported column — and that lands as `origin: "user"`. Under an
   * origin-only touched rule, a later user edit matched its own origin, left `touched` false, and
   * the canvas kept presenting a now-wrong explanation as current.
   */
  const legacy = (): Schema => ({
    tables: [
      {
        id: "t1",
        name: "pharmacy",
        x: 0,
        y: 0,
        fields: [{ id: "f1", name: "pharmacy_id", type: "integer", pk: false, fk: false }],
      },
    ],
    relationships: [],
  });

  function explained(): Schema {
    const makeId = makeTestIds();
    return applyActions(
      legacy(),
      [
        {
          op: "set_pk",
          table: "pharmacy",
          field: "pharmacy_id",
          pk: true,
          rationale: { text: "distinct across all sampled rows" },
        },
      ],
      { makeId, actor: "ai" },
    ).schema;
  }

  it("goes stale when the user edits a user-origin entity the copilot explained", () => {
    const makeId = makeTestIds();
    const { schema } = applyActions(
      explained(),
      [{ op: "set_type", table: "pharmacy", field: "pharmacy_id", type: "bigint" }],
      { makeId, actor: "user" },
    );

    const provenance = field(schema, "pharmacy", "pharmacy_id").provenance;
    expect(provenance?.origin).toBe("user");
    expect(provenance?.touched).toBe(true);
    expect(provenance?.rationale?.text).toBe("distinct across all sampled rows");
  });

  it("goes stale on an import-driven edit too — only the copilot's own edits are exempt", () => {
    const makeId = makeTestIds();
    const { schema } = applyActions(
      explained(),
      [{ op: "set_type", table: "pharmacy", field: "pharmacy_id", type: "bigint" }],
      { makeId, actor: "imported" },
    );

    expect(field(schema, "pharmacy", "pharmacy_id").provenance?.touched).toBe(true);
  });

  it("stays current when the copilot edits what it explained", () => {
    const makeId = makeTestIds();
    const { schema } = applyActions(
      explained(),
      [{ op: "set_type", table: "pharmacy", field: "pharmacy_id", type: "bigint" }],
      { makeId, actor: "ai" },
    );

    expect(field(schema, "pharmacy", "pharmacy_id").provenance?.touched).toBe(false);
  });

  it("leaves an unexplained user entity untouched by the user's own edits", () => {
    const makeId = makeTestIds();
    const { schema } = applyActions(
      seed("user"),
      [{ op: "set_type", table: "orders", field: "customer_id", type: "text" }],
      { makeId, actor: "user" },
    );

    expect(field(schema, "orders", "customer_id").provenance?.touched).toBe(false);
  });
});
