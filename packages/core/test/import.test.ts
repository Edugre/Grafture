import { describe, expect, it } from "vitest";

import { fromSql } from "../src/import/index.js";
import { toSql } from "../src/export/index.js";
import { SchemaSchema } from "../src/model.js";
import type { Schema } from "../src/model.js";

/**
 * A deterministic id factory so imported schemas are stable and comparable across runs. Ids only
 * need to be unique within a schema, which a monotonic counter guarantees.
 */
function counterIds(): () => string {
  let n = 0;
  return () => `id_${n++}`;
}

/**
 * The shape that actually matters for an import — table/field structure and resolved
 * relationships by name — with the synthetic ids and layout geometry stripped out.
 */
function structure(schema: Schema) {
  const tableName = new Map(schema.tables.map((t) => [t.id, t.name]));
  const fieldName = new Map(
    schema.tables.flatMap((t) => t.fields.map((f) => [f.id, `${t.name}.${f.name}`] as const)),
  );
  return {
    tables: schema.tables.map((t) => ({
      name: t.name,
      fields: t.fields.map((f) => ({ name: f.name, type: f.type, pk: f.pk, fk: f.fk })),
    })),
    relationships: schema.relationships
      .map((r) => ({
        from: fieldName.get(r.fromField),
        to: fieldName.get(r.toField),
        fromTable: tableName.get(r.fromTable),
        toTable: tableName.get(r.toTable),
        cardinality: r.cardinality,
      }))
      .sort((a, b) => `${a.from}`.localeCompare(`${b.from}`)),
  };
}

/** Canonical-typed fixture that survives a toSql → fromSql round-trip losslessly. */
function schema340B(): Schema {
  return {
    tables: [
      {
        id: "t_ce",
        name: "covered_entities",
        x: 0,
        y: 0,
        fields: [
          { id: "ce_id", name: "id", type: "integer", pk: true, fk: false },
          { id: "ce_grant", name: "grant_number", type: "text", pk: false, fk: false },
          { id: "ce_org", name: "org_id", type: "integer", pk: false, fk: true },
        ],
      },
      {
        id: "t_org",
        name: "organizations",
        x: 0,
        y: 0,
        fields: [
          { id: "org_id", name: "id", type: "integer", pk: true, fk: false },
          { id: "org_name", name: "name", type: "text", pk: false, fk: false },
        ],
      },
    ],
    relationships: [
      {
        id: "r1",
        fromTable: "t_ce",
        fromField: "ce_org",
        toTable: "t_org",
        toField: "org_id",
        cardinality: "1:N",
      },
    ],
  };
}

describe("fromSql", () => {
  it("round-trips a schema through toSql without losing structure", () => {
    const original = schema340B();
    const { schema, warnings } = fromSql(toSql(original), { makeId: counterIds() });
    expect(warnings).toEqual([]);
    expect(structure(schema)).toEqual(structure(original));
  });

  it("reads an inline PRIMARY KEY and an inline REFERENCES", () => {
    const { schema, warnings } = fromSql(
      [
        "CREATE TABLE organizations (",
        "  id integer PRIMARY KEY,",
        "  name text",
        ");",
        "CREATE TABLE covered_entities (",
        "  id integer PRIMARY KEY,",
        "  org_id integer REFERENCES organizations (id)",
        ");",
      ].join("\n"),
      { makeId: counterIds() },
    );

    expect(warnings).toEqual([]);
    const ce = schema.tables.find((t) => t.name === "covered_entities")!;
    expect(ce.fields.find((f) => f.name === "org_id")).toMatchObject({ fk: true, pk: false });
    expect(schema.relationships).toHaveLength(1);
    expect(schema.relationships[0]!.cardinality).toBe("1:N");
  });

  it("resolves an inline REFERENCES with no column list to the target's single primary key", () => {
    const { schema, warnings } = fromSql(
      [
        "CREATE TABLE orgs (id integer PRIMARY KEY, name text);",
        "CREATE TABLE users (id integer PRIMARY KEY, org_id integer REFERENCES orgs);",
      ].join("\n"),
      { makeId: counterIds() },
    );

    expect(warnings).toEqual([]);
    const orgs = schema.tables.find((t) => t.name === "orgs")!;
    const rel = schema.relationships[0]!;
    expect(rel.toField).toBe(orgs.fields.find((f) => f.name === "id")!.id);
  });

  it("reads a composite PRIMARY KEY constraint", () => {
    const { schema } = fromSql(
      [
        "CREATE TABLE memberships (",
        "  user_id integer,",
        "  group_id integer,",
        "  PRIMARY KEY (user_id, group_id)",
        ");",
      ].join("\n"),
      { makeId: counterIds() },
    );

    const memberships = schema.tables[0]!;
    expect(memberships.fields.filter((f) => f.pk).map((f) => f.name)).toEqual([
      "user_id",
      "group_id",
    ]);
  });

  it("reads a standalone ALTER TABLE ... ADD FOREIGN KEY", () => {
    const { schema, warnings } = fromSql(
      [
        'CREATE TABLE "covered_entities" (',
        '  "id" integer PRIMARY KEY,',
        '  "org_id" integer',
        ");",
        'CREATE TABLE "organizations" (',
        '  "id" integer PRIMARY KEY',
        ");",
        'ALTER TABLE "covered_entities" ADD CONSTRAINT "covered_entities_org_id_fkey" ' +
          'FOREIGN KEY ("org_id") REFERENCES "organizations" ("id");',
      ].join("\n"),
      { makeId: counterIds() },
    );

    expect(warnings).toEqual([]);
    expect(schema.relationships).toHaveLength(1);
    const ce = schema.tables.find((t) => t.name === "covered_entities")!;
    expect(ce.fields.find((f) => f.name === "org_id")!.fk).toBe(true);
  });

  it("handles quoted identifiers with spaces and punctuation", () => {
    const { schema } = fromSql(
      [
        'CREATE TABLE "Covered Entities" (',
        '  "Grant Number" text PRIMARY KEY,',
        '  "Org (ID)" integer',
        ");",
      ].join("\n"),
      { makeId: counterIds() },
    );

    const table = schema.tables[0]!;
    expect(table.name).toBe("Covered Entities");
    expect(table.fields.map((f) => f.name)).toEqual(["Grant Number", "Org (ID)"]);
    expect(table.fields[0]!.pk).toBe(true);
  });

  it("is case-insensitive on keywords and accepts IF NOT EXISTS and schema qualifiers", () => {
    const { schema } = fromSql(
      "create table if not exists public.orders ( id Integer Primary Key, total Numeric );",
      { makeId: counterIds() },
    );

    expect(schema.tables[0]!.name).toBe("orders");
    expect(schema.tables[0]!.fields).toMatchObject([
      { name: "id", type: "integer", pk: true },
      { name: "total", type: "numeric", pk: false },
    ]);
  });

  it("normalizes type synonyms and preserves parameterized and unknown types verbatim", () => {
    const { schema } = fromSql(
      [
        "CREATE TABLE t (",
        "  a int4,",
        "  b bigint,",
        "  c bool,",
        "  d double precision,",
        "  e timestamp with time zone,",
        "  f varchar(255),",
        "  g numeric(10, 2),",
        "  h uuid,",
        "  i jsonb,",
        "  j geography(Point, 4326)",
        ");",
      ].join("\n"),
      { makeId: counterIds() },
    );

    expect(schema.tables[0]!.fields.map((f) => f.type)).toEqual([
      "integer",
      "integer",
      "boolean",
      "numeric",
      "timestamptz",
      "varchar(255)",
      "numeric(10, 2)",
      "uuid",
      "jsonb",
      "geography(Point, 4326)",
    ]);
  });

  it("strips line and block comments and tolerates extra whitespace and trailing semicolons", () => {
    const { schema, warnings } = fromSql(
      [
        "-- a leading comment",
        "CREATE TABLE t (",
        "  id integer PRIMARY KEY, -- the key",
        "  /* inline */ name text",
        ");;",
      ].join("\n"),
      { makeId: counterIds() },
    );

    expect(warnings).toEqual([]);
    expect(schema.tables[0]!.fields.map((f) => f.name)).toEqual(["id", "name"]);
  });

  it("silently skips extension and session statements", () => {
    const { schema, warnings } = fromSql(
      [
        "CREATE EXTENSION IF NOT EXISTS citext;",
        "SET client_encoding = 'UTF8';",
        "CREATE TABLE t (id integer PRIMARY KEY);",
      ].join("\n"),
      { makeId: counterIds() },
    );

    expect(warnings).toEqual([]);
    expect(schema.tables).toHaveLength(1);
  });

  it("does not mistake PRIMARY KEY / REFERENCES inside CHECK or DEFAULT for real constraints", () => {
    const { schema } = fromSql(
      [
        "CREATE TABLE orgs (id integer PRIMARY KEY);",
        "CREATE TABLE t (",
        "  a text CHECK (a <> 'primary key'),",
        "  body text DEFAULT 'references orgs',",
        "  label text",
        ");",
      ].join("\n"),
      { makeId: counterIds() },
    );

    const t = schema.tables.find((table) => table.name === "t")!;
    // The CHECK text must not make `a` a primary key.
    expect(t.fields.every((f) => !f.pk)).toBe(true);
    // The DEFAULT literal must not create a foreign key.
    expect(schema.relationships).toEqual([]);
    expect(t.fields.find((f) => f.name === "body")!.fk).toBe(false);
  });

  it("still reads a real inline constraint that sits alongside a CHECK or DEFAULT", () => {
    const { schema, warnings } = fromSql(
      [
        "CREATE TABLE orgs (id integer PRIMARY KEY);",
        "CREATE TABLE t (",
        "  id integer PRIMARY KEY CHECK (id > 0),",
        "  org_id integer DEFAULT 0 REFERENCES orgs (id)",
        ");",
      ].join("\n"),
      { makeId: counterIds() },
    );

    expect(warnings).toEqual([]);
    const t = schema.tables.find((table) => table.name === "t")!;
    expect(t.fields.find((f) => f.name === "id")!.pk).toBe(true);
    expect(t.fields.find((f) => f.name === "org_id")!.fk).toBe(true);
    expect(schema.relationships).toHaveLength(1);
  });

  it("keeps a dollar-quoted function body as a single skipped statement", () => {
    const { schema, warnings } = fromSql(
      [
        "CREATE TABLE t (id integer PRIMARY KEY);",
        "CREATE FUNCTION f() RETURNS trigger AS $$",
        "BEGIN",
        "  INSERT INTO audit VALUES (1);",
        "  RETURN NEW;",
        "END;",
        "$$ LANGUAGE plpgsql;",
      ].join("\n"),
      { makeId: counterIds() },
    );

    expect(schema.tables.map((table) => table.name)).toEqual(["t"]);
    // The whole function is one skipped statement, not one warning per internal semicolon.
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("CREATE FUNCTION");
  });

  it("does not treat CREATE TABLE inside a dollar-quoted body as a real table", () => {
    const { schema } = fromSql(
      [
        "CREATE TABLE real_table (id integer PRIMARY KEY);",
        "CREATE FUNCTION seed() RETURNS void AS $body$",
        "BEGIN",
        "  CREATE TABLE not_a_real_table (id integer PRIMARY KEY);",
        "END;",
        "$body$ LANGUAGE plpgsql;",
      ].join("\n"),
      { makeId: counterIds() },
    );

    expect(schema.tables.map((table) => table.name)).toEqual(["real_table"]);
  });

  it("warns and skips a statement it cannot model", () => {
    const { schema, warnings } = fromSql(
      ["CREATE TABLE t (id integer PRIMARY KEY);", "CREATE INDEX idx_t_id ON t (id);"].join("\n"),
      { makeId: counterIds() },
    );

    expect(schema.tables).toHaveLength(1);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("CREATE INDEX");
  });

  it("warns and skips a foreign key that references an unknown table", () => {
    const { schema, warnings } = fromSql(
      "CREATE TABLE users (id integer PRIMARY KEY, org_id integer REFERENCES orgs (id));",
      { makeId: counterIds() },
    );

    expect(schema.relationships).toEqual([]);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain("unknown table");
  });

  it("throws ParseError when there is no CREATE TABLE to import", () => {
    expect(() => fromSql("SELECT 1;")).toThrow(/No CREATE TABLE/);
    expect(() => fromSql("not sql at all")).toThrow();
  });

  it("produces a schema that satisfies the domain model", () => {
    const { schema } = fromSql(toSql(schema340B()), { makeId: counterIds() });
    expect(() => SchemaSchema.parse(schema)).not.toThrow();
  });
});
