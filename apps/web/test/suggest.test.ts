import type { FieldStats, JoinKeyCandidate, Schema, Source } from "@schema-studio/core";
import { detectJoinKeys, emptySchema } from "@schema-studio/core";
import { describe, expect, it } from "vitest";

import {
  buildApplyPlan,
  buildJoinSuggestions,
  buildKeySuggestions,
  buildSetPkPlan,
} from "../src/suggest/joinSuggestions.js";

function source(id: string, name: string, field: string, samples: string[]): Source {
  return {
    id,
    name,
    kind: "csv",
    fields: [{ name: field, type: "text", samples }],
  };
}

/** Single-field source carrying value stats — needed by grain/PK inference. */
function statSource(
  id: string,
  name: string,
  field: string,
  samples: string[],
  stats: FieldStats,
): Source {
  return { id, name, kind: "csv", fields: [{ name: field, type: "int", samples, stats }] };
}

/** A schema with one table built from `name` holding a single `field`. */
function schemaWith(tableName: string, field: string, pk = false): Schema {
  return {
    tables: [
      {
        id: `t-${tableName}`,
        name: tableName,
        x: 0,
        y: 0,
        fields: [{ id: `f-${field}`, name: field, type: "int", pk, fk: false }],
      },
    ],
    relationships: [],
  };
}

// HRSA pads grant numbers with leading zeros; OPAIS does not. Same entities, different format.
const hrsa = source("s-hrsa", "covered_entities.csv", "grant_number", ["01234", "05678", "09999"]);
const opais = source("s-opais", "organizations.csv", "grant_id", ["1234", "5678", "0001"]);

function onlyCandidate(sources: Source[]): JoinKeyCandidate {
  const [candidate] = detectJoinKeys(sources);
  if (!candidate) {
    throw new Error("expected a join candidate");
  }
  return candidate;
}

describe("buildJoinSuggestions", () => {
  it("surfaces overlap, shared count, and a normalization warning from sample values", () => {
    const [suggestion, ...rest] = buildJoinSuggestions([hrsa, opais], emptySchema());

    expect(rest).toHaveLength(0);
    expect(suggestion?.leftLabel).toBe("covered_entities.csv · grant_number");
    expect(suggestion?.rightLabel).toBe("organizations.csv · grant_id");
    expect(suggestion?.overlapPercent).toBe(50);
    expect(suggestion?.sharedValues).toBe(2);
    expect(suggestion?.warning).toContain("strip leading zeros");
    expect(suggestion?.alreadyLinked).toBe(false);
  });

  it("marks a suggestion already linked when the schema has the relationship", () => {
    const schema: Schema = {
      tables: [
        {
          id: "t1",
          name: "covered_entities",
          x: 0,
          y: 0,
          fields: [{ id: "f1", name: "grant_number", type: "text", pk: false, fk: false }],
        },
        {
          id: "t2",
          name: "organizations",
          x: 0,
          y: 0,
          fields: [{ id: "f2", name: "grant_id", type: "text", pk: false, fk: true }],
        },
      ],
      relationships: [
        {
          id: "r1",
          fromTable: "t1",
          fromField: "f1",
          toTable: "t2",
          toField: "f2",
          cardinality: "1:N",
        },
      ],
    };

    const [suggestion] = buildJoinSuggestions([hrsa, opais], schema);
    expect(suggestion?.alreadyLinked).toBe(true);
  });

  it("returns nothing when sources share no values", () => {
    const a = source("a", "a.csv", "code", ["aaa", "bbb", "ccc"]);
    const b = source("b", "b.csv", "code", ["xxx", "yyy", "zzz"]);
    expect(buildJoinSuggestions([a, b], emptySchema())).toEqual([]);
  });
});

describe("buildApplyPlan", () => {
  it("builds both tables from their sources, then links the columns", () => {
    const candidate = onlyCandidate([hrsa, opais]);
    const plan = buildApplyPlan([hrsa, opais], emptySchema(), candidate);

    expect(plan.ok).toBe(true);
    if (!plan.ok) return;

    expect(plan.builtTables).toEqual(["covered_entities", "organizations"]);
    expect(plan.actions).toEqual([
      {
        op: "add_table",
        name: "covered_entities",
        fields: [{ name: "grant_number", type: "text" }],
      },
      {
        op: "add_table",
        name: "organizations",
        fields: [{ name: "grant_id", type: "text" }],
      },
      {
        op: "add_relationship",
        from_table: "covered_entities",
        from_field: "grant_number",
        to_table: "organizations",
        to_field: "grant_id",
        cardinality: "1:N",
      },
    ]);
  });

  it("reuses existing tables instead of rebuilding them", () => {
    const schema: Schema = {
      tables: [
        {
          id: "t1",
          name: "covered_entities",
          x: 0,
          y: 0,
          fields: [{ id: "f1", name: "grant_number", type: "text", pk: false, fk: false }],
        },
        {
          id: "t2",
          name: "organizations",
          x: 0,
          y: 0,
          fields: [{ id: "f2", name: "grant_id", type: "text", pk: false, fk: false }],
        },
      ],
      relationships: [],
    };

    const candidate = onlyCandidate([hrsa, opais]);
    const plan = buildApplyPlan([hrsa, opais], schema, candidate);

    expect(plan.ok).toBe(true);
    if (!plan.ok) return;

    expect(plan.builtTables).toEqual([]);
    expect(plan.actions).toEqual([
      {
        op: "add_relationship",
        from_table: "covered_entities",
        from_field: "grant_number",
        to_table: "organizations",
        to_field: "grant_id",
        cardinality: "1:N",
      },
    ]);
  });

  it("disambiguates two new tables whose filenames collide", () => {
    const left = source("l", "data.csv", "ref", ["100", "200", "300"]);
    const right = source("r", "data.csv", "ref", ["100", "200", "400"]);
    const candidate = onlyCandidate([left, right]);
    const plan = buildApplyPlan([left, right], emptySchema(), candidate);

    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.builtTables).toEqual(["data", "data_2"]);
  });

  it("fails cleanly when a source is no longer loaded", () => {
    const candidate = onlyCandidate([hrsa, opais]);
    const plan = buildApplyPlan([hrsa], emptySchema(), candidate);
    expect(plan).toEqual({ ok: false, error: "Those sources are no longer loaded." });
  });
});

// orders.customer_id repeats (many); customers.id is unique (one) → many-to-one.
const orders = statSource("o", "orders.csv", "customer_id", ["1", "2", "3"], {
  nonEmpty: 6,
  distinct: 3,
  blank: 0,
});
const customers = statSource("c", "customers.csv", "id", ["1", "2", "3"], {
  nonEmpty: 4,
  distinct: 4,
  blank: 0,
});

describe("grain-aware join suggestions", () => {
  it("surfaces the inferred grain label", () => {
    const [suggestion] = buildJoinSuggestions([orders, customers], emptySchema());
    expect(suggestion?.grainLabel).toBe("N:1");
  });

  it("orients the relationship from the many side to the unique side as 1:N", () => {
    const candidate = onlyCandidate([orders, customers]);
    const plan = buildApplyPlan([orders, customers], emptySchema(), candidate);

    expect(plan.ok).toBe(true);
    if (!plan.ok) return;

    // The add_relationship is flipped: FK points from orders (many) → customers (one).
    expect(plan.actions.at(-1)).toEqual({
      op: "add_relationship",
      from_table: "customers",
      from_field: "id",
      to_table: "orders",
      to_field: "customer_id",
      cardinality: "1:N",
    });
  });

  it("falls back to 1:N with no flip when sources carry no stats", () => {
    const candidate = onlyCandidate([hrsa, opais]);
    const plan = buildApplyPlan([hrsa, opais], emptySchema(), candidate);
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.actions.at(-1)).toMatchObject({
      from_table: "covered_entities",
      to_table: "organizations",
      cardinality: "1:N",
    });
  });
});

describe("buildKeySuggestions", () => {
  it("proposes a unique, non-null column whose table is on the canvas", () => {
    const [suggestion, ...rest] = buildKeySuggestions([customers], schemaWith("customers", "id"));

    expect(rest).toHaveLength(0);
    expect(suggestion?.label).toBe("customers · id");
    expect(suggestion?.tableName).toBe("customers");
    expect(suggestion?.reason).toContain("unique and non-null");
  });

  it("hides a suggestion once the field is already the primary key", () => {
    const suggestions = buildKeySuggestions([customers], schemaWith("customers", "id", true));
    expect(suggestions).toEqual([]);
  });

  it("does not suggest keys for sources whose table is not built yet", () => {
    expect(buildKeySuggestions([customers], emptySchema())).toEqual([]);
  });

  it("ignores columns the data shows are not unique", () => {
    const dup = statSource("d", "events.csv", "kind", ["a", "b"], {
      nonEmpty: 50,
      distinct: 2,
      blank: 0,
    });
    expect(buildKeySuggestions([dup], schemaWith("events", "kind"))).toEqual([]);
  });
});

describe("buildSetPkPlan", () => {
  it("emits a single validated set_pk action", () => {
    const [suggestion] = buildKeySuggestions([customers], schemaWith("customers", "id"));
    if (!suggestion) throw new Error("expected a key suggestion");

    expect(buildSetPkPlan(suggestion)).toEqual({
      actions: [{ op: "set_pk", table: "customers", field: "id", pk: true }],
    });
  });
});
