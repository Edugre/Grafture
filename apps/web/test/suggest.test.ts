import type { FieldStats, JoinKeyCandidate, Schema, Source } from "@grafture/core";
import { detectJoinKeys, emptySchema } from "@grafture/core";
import { describe, expect, it } from "vitest";

import {
  buildApplyPlan,
  buildJoinSuggestions,
  buildKeySuggestions,
  buildSetPkPlan,
  buildSetTypePlan,
  buildTypeSuggestions,
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
function schemaWith(tableName: string, field: string, pk = false, type = "int"): Schema {
  return {
    tables: [
      {
        id: `t-${tableName}`,
        name: tableName,
        x: 0,
        y: 0,
        fields: [{ id: `f-${field}`, name: field, type, pk, fk: false }],
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

describe("buildTypeSuggestions", () => {
  it("flags a canvas field whose type disagrees with its source data", () => {
    // customers.id infers "int" from its values, but the canvas field was left as "text".
    const [suggestion, ...rest] = buildTypeSuggestions(
      [customers],
      schemaWith("customers", "id", false, "text"),
    );

    expect(rest).toHaveLength(0);
    expect(suggestion?.label).toBe("customers · id");
    expect(suggestion?.currentType).toBe("text");
    expect(suggestion?.suggestedType).toBe("int");
    expect(suggestion?.reason).toBe("data looks like int, not text");
  });

  it("stays quiet when the field already matches the inferred type", () => {
    expect(buildTypeSuggestions([customers], schemaWith("customers", "id", false, "int"))).toEqual(
      [],
    );
  });

  it("does not suggest types for sources whose table is not built yet", () => {
    expect(buildTypeSuggestions([customers], emptySchema())).toEqual([]);
  });
});

describe("buildSetTypePlan", () => {
  it("emits a single validated set_type action", () => {
    const [suggestion] = buildTypeSuggestions(
      [customers],
      schemaWith("customers", "id", false, "text"),
    );
    if (!suggestion) throw new Error("expected a type suggestion");

    expect(buildSetTypePlan(suggestion)).toEqual({
      actions: [{ op: "set_type", table: "customers", field: "id", type: "int" }],
    });
  });
});

/* PR-5 (GAP E): an N:M grain must be scaffolded as a junction table (composite PK, one 1:N
 * per side), never a direct N:M edge. */
describe("buildApplyPlan N:M junction scaffolding", () => {
  // Both sides repeat: students take many courses, courses have many students.
  const students = statSource("s-st", "students.csv", "course_code", ["C1", "C2", "C3"], {
    nonEmpty: 9,
    distinct: 3,
    blank: 0,
  });
  const courses = statSource("s-co", "courses.csv", "course_code", ["C1", "C2", "C3"], {
    nonEmpty: 8,
    distinct: 3,
    blank: 0,
  });

  it("emits a junction table with composite PK and two 1:N relationships", () => {
    const candidate = onlyCandidate([students, courses]);
    expect(candidate.grain).toBe("N:M");

    const plan = buildApplyPlan([students, courses], emptySchema(), candidate);
    if (!plan.ok) {
      throw new Error(plan.error);
    }

    // Both entity tables plus the junction get built.
    expect(plan.builtTables).toEqual(["students", "courses", "students_courses"]);

    const ops = plan.actions as Array<Record<string, unknown>>;
    const junctionAdd = ops.find(
      (action) => action["op"] === "add_table" && action["name"] === "students_courses",
    );
    // Same field name on both sides — the junction de-collides its two key columns.
    expect(junctionAdd?.["fields"]).toEqual([
      { name: "course_code", type: "int", fk: true },
      { name: "course_code_2", type: "int", fk: true },
    ]);

    const setPks = ops.filter(
      (action) => action["op"] === "set_pk" && action["table"] === "students_courses",
    );
    expect(setPks.map((action) => action["field"])).toEqual(["course_code", "course_code_2"]);

    const relationships = ops.filter((action) => action["op"] === "add_relationship");
    expect(relationships).toEqual([
      {
        op: "add_relationship",
        from_table: "students",
        from_field: "course_code",
        to_table: "students_courses",
        to_field: "course_code",
        cardinality: "1:N",
      },
      {
        op: "add_relationship",
        from_table: "courses",
        from_field: "course_code",
        to_table: "students_courses",
        to_field: "course_code_2",
        cardinality: "1:N",
      },
    ]);
    // No direct N:M edge between the entity tables.
    expect(relationships.some((action) => action["cardinality"] === "N:M")).toBe(false);
  });
});
