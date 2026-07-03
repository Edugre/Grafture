import { describe, expect, it } from "vitest";

import { emptySchema } from "../src/model.js";
import type { Schema } from "../src/model.js";
import { toDbml, toPrisma, toSql } from "../src/export/index.js";

/**
 * The "340B" schema from the roadmap: covered_entities join to organizations on a
 * grant/org key. Small, but exercises pk, a typed fk column, and a 1:N relationship.
 */
function schema340B(): Schema {
  return {
    tables: [
      {
        id: "t_ce",
        name: "covered_entities",
        x: 0,
        y: 0,
        fields: [
          { id: "ce_id", name: "id", type: "int", pk: true, fk: false },
          { id: "ce_grant", name: "grant_number", type: "text", pk: false, fk: false },
          { id: "ce_org", name: "org_id", type: "int", pk: false, fk: true },
        ],
      },
      {
        id: "t_org",
        name: "organizations",
        x: 0,
        y: 0,
        fields: [
          { id: "org_id", name: "id", type: "int", pk: true, fk: false },
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

/** Names exactly as they arrive from real CSV headers — spaces, punctuation, no sanitizing. */
function rawHeaderSchema(): Schema {
  return {
    tables: [
      {
        id: "t_ce",
        name: "Covered Entities",
        x: 0,
        y: 0,
        fields: [
          { id: "f_grant", name: "Grant Number", type: "text", pk: true, fk: false },
          { id: "f_org", name: "Org (ID)", type: "int", pk: false, fk: true },
        ],
      },
      {
        id: "t_org",
        name: "orgs",
        x: 0,
        y: 0,
        fields: [{ id: "f_id", name: "id", type: "int", pk: true, fk: false }],
      },
    ],
    relationships: [
      {
        id: "r1",
        fromTable: "t_ce",
        fromField: "f_org",
        toTable: "t_org",
        toField: "f_id",
        cardinality: "1:N",
      },
    ],
  };
}

describe("export", () => {
  describe("toDbml", () => {
    it("emits tables, typed columns, pk, and an inline ref with cardinality", () => {
      expect(toDbml(schema340B())).toBe(
        [
          "Table covered_entities {",
          "  id int [pk]",
          "  grant_number text",
          "  org_id int [ref: > organizations.id]",
          "}",
          "",
          "Table organizations {",
          "  id int [pk]",
          "  name text",
          "}",
        ].join("\n"),
      );
    });

    it("returns an empty string for an empty schema", () => {
      expect(toDbml(emptySchema())).toBe("");
    });

    it("quotes identifiers that came verbatim from source headers", () => {
      expect(toDbml(rawHeaderSchema())).toBe(
        [
          'Table "Covered Entities" {',
          '  "Grant Number" text [pk]',
          '  "Org (ID)" int [ref: > orgs.id]',
          "}",
          "",
          "Table orgs {",
          "  id int [pk]",
          "}",
        ].join("\n"),
      );
    });
  });

  describe("toSql", () => {
    it("emits CREATE TABLE with PK and a FK constraint (postgres)", () => {
      expect(toSql(schema340B())).toBe(
        [
          'CREATE TABLE "covered_entities" (',
          '  "id" integer PRIMARY KEY,',
          '  "grant_number" text,',
          '  "org_id" integer',
          ");",
          "",
          'CREATE TABLE "organizations" (',
          '  "id" integer PRIMARY KEY,',
          '  "name" text',
          ");",
          "",
          'ALTER TABLE "covered_entities" ADD CONSTRAINT "covered_entities_org_id_fkey" ' +
            'FOREIGN KEY ("org_id") REFERENCES "organizations" ("id");',
        ].join("\n"),
      );
    });

    it("emits a composite PRIMARY KEY when more than one field is a pk", () => {
      const schema: Schema = {
        tables: [
          {
            id: "t",
            name: "memberships",
            x: 0,
            y: 0,
            fields: [
              { id: "a", name: "user_id", type: "int", pk: true, fk: false },
              { id: "b", name: "group_id", type: "int", pk: true, fk: false },
            ],
          },
        ],
        relationships: [],
      };

      expect(toSql(schema)).toBe(
        [
          'CREATE TABLE "memberships" (',
          '  "user_id" integer,',
          '  "group_id" integer,',
          '  PRIMARY KEY ("user_id", "group_id")',
          ");",
        ].join("\n"),
      );
    });

    it("emits CREATE EXTENSION preambles for extension-backed column types", () => {
      const schema: Schema = {
        tables: [
          {
            id: "t",
            name: "stores",
            x: 0,
            y: 0,
            fields: [
              { id: "a", name: "id", type: "int", pk: true, fk: false },
              { id: "b", name: "location", type: "geography(Point, 4326)", pk: false, fk: false },
              { id: "c", name: "email", type: "citext", pk: false, fk: false },
            ],
          },
        ],
        relationships: [],
      };

      const sql = toSql(schema);

      // Extensions come first (alphabetical, deterministic) so the CREATE TABLE succeeds.
      expect(sql.startsWith("CREATE EXTENSION IF NOT EXISTS citext;")).toBe(true);
      expect(sql).toContain("CREATE EXTENSION IF NOT EXISTS postgis;");
      expect(sql.indexOf("CREATE EXTENSION IF NOT EXISTS postgis;")).toBeLessThan(
        sql.indexOf("CREATE TABLE"),
      );
      expect(sql).toContain('"location" geography(Point, 4326)');
    });

    it("emits no extension preamble for plain types", () => {
      expect(toSql(schema340B())).not.toContain("CREATE EXTENSION");
    });
  });

  describe("toPrisma", () => {
    it("emits models with @id, mapped scalar types, and both relation sides", () => {
      expect(toPrisma(schema340B())).toBe(
        [
          "model covered_entities {",
          "  id Int @id",
          "  grant_number String",
          "  org_id Int",
          "  organizations organizations @relation(fields: [org_id], references: [id])",
          "}",
          "",
          "model organizations {",
          "  id Int @id",
          "  name String",
          "  covered_entities covered_entities[]",
          "}",
        ].join("\n"),
      );
    });

    it("sanitizes raw-header names into legal identifiers mapped back with @map/@@map", () => {
      expect(toPrisma(rawHeaderSchema())).toBe(
        [
          "model Covered_Entities {",
          '  Grant_Number String @id @map("Grant Number")',
          '  Org__ID_ Int @map("Org (ID)")',
          "  orgs orgs @relation(fields: [Org__ID_], references: [id])",
          '  @@map("Covered Entities")',
          "}",
          "",
          "model orgs {",
          "  id Int @id",
          "  Covered_Entities Covered_Entities[]",
          "}",
        ].join("\n"),
      );
    });
  });

  it("produces deterministic output across repeated calls", () => {
    const schema = schema340B();
    expect(toDbml(schema)).toBe(toDbml(schema));
    expect(toSql(schema)).toBe(toSql(schema));
    expect(toPrisma(schema)).toBe(toPrisma(schema));
  });
});
