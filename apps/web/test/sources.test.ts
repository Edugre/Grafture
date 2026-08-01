import type { Schema, Source } from "@grafture/core";
import { emptySchema } from "@grafture/core";
import { describe, expect, it, vi } from "vitest";

import { buildTableFromSource } from "../src/sources/buildFromSource.js";
import { detectSourceKind } from "../src/sources/detectKind.js";
import {
  tableNameForSource,
  tableNameFromFilename,
  uniqueTableName,
} from "../src/sources/tableName.js";

describe("detectSourceKind", () => {
  it("detects supported extensions", () => {
    expect(detectSourceKind("data.csv")).toBe("csv");
    expect(detectSourceKind("data.tsv")).toBe("csv");
    expect(detectSourceKind("book.xlsx")).toBe("xlsx");
    expect(detectSourceKind("legacy.xls")).toBe("xlsx");
    expect(detectSourceKind("payload.json")).toBe("json");
    expect(detectSourceKind("notes.txt")).toBeNull();
  });
});

describe("tableNameFromFilename", () => {
  it("strips extensions and sanitizes names", () => {
    expect(tableNameFromFilename("covered_entities.csv")).toBe("covered_entities");
    expect(tableNameFromFilename("340B HRSA File.xlsx")).toBe("_340B_HRSA_File");
  });
});

describe("tableNameForSource", () => {
  it("keeps the array-field segment for derived child sources", () => {
    // The filename rule alone would eat ".npiNumbers" as an extension → "opais_json".
    expect(
      tableNameForSource({
        name: "opais.json.npiNumbers",
        derivedFrom: { parentId: "p1", arrayField: "npiNumbers" },
      }),
    ).toBe("opais_npiNumbers");
  });

  it("falls back to the filename rule for ordinary sources", () => {
    expect(tableNameForSource({ name: "opais.json" })).toBe("opais");
  });
});

describe("uniqueTableName", () => {
  it("avoids collisions case-insensitively", () => {
    const schema = emptySchema();
    schema.tables.push({
      id: "t1",
      name: "Users",
      x: 0,
      y: 0,
      fields: [],
    });

    expect(uniqueTableName(schema, "users")).toBe("users_2");
  });
});

describe("buildTableFromSource", () => {
  it("routes through runActions with all fields", () => {
    const runActions = vi.fn(() => ({
      applied: [{ op: "add_table", tableIds: ["t-new"] }],
      rejected: [],
    }));

    const result = buildTableFromSource(runActions, emptySchema(), {
      id: "s1",
      name: "orgs.csv",
      kind: "csv",
      fields: [
        { name: "grant_number", type: "text", samples: ["01234"] },
        { name: "count", type: "int", samples: ["1"] },
      ],
    });

    expect(runActions).toHaveBeenCalledWith(
      [
        {
          op: "add_table",
          name: "orgs",
          fields: [
            { name: "grant_number", type: "text" },
            { name: "count", type: "int" },
          ],
        },
      ],
      // The table's shape is the file's own, so it is attributed to the import rather than to
      // the user who clicked build.
      { actor: "imported" },
    );
    expect(result.tableName).toBe("orgs");
  });
});

describe("buildTableFromSource structural parent↔child link", () => {
  // Surrogates renamed by the parser (the data already used _rowId/_parentId): the link must
  // follow the `synthetic` flag, never the literal names.
  const parentSource: Source = {
    id: "p1",
    name: "opais.json",
    kind: "json",
    fields: [
      { name: "grantNumber", type: "text", samples: [] },
      { name: "_rowId", type: "text", samples: ["legacy"] },
      { name: "_rowId_2", type: "int", samples: ["0"], synthetic: true },
    ],
  };
  const childSource: Source = {
    id: "c1",
    name: "opais.json.npiNumbers",
    kind: "json",
    fields: [
      { name: "npiNumber", type: "text", samples: [] },
      { name: "_parentId_2", type: "int", samples: ["0"], synthetic: true },
    ],
    derivedFrom: { parentId: "p1", arrayField: "npiNumbers" },
  };

  function table(id: string, name: string, fieldNames: string[]): Schema["tables"][number] {
    return {
      id,
      name,
      x: 0,
      y: 0,
      fields: fieldNames.map((field) => ({
        id: `${id}-${field}`,
        name: field,
        type: "text",
        pk: false,
        fk: false,
      })),
    };
  }

  const okRunActions = () =>
    vi.fn<(actions: unknown[]) => { applied: { op: string; tableIds: string[] }[]; rejected: [] }>(
      () => ({ applied: [{ op: "add_table", tableIds: ["t-new"] }], rejected: [] }),
    );

  it("links a child to its parent's table on the renamed surrogate pair", () => {
    const schema: Schema = {
      tables: [table("t-p", "opais", ["grantNumber", "_rowId", "_rowId_2"])],
      relationships: [],
    };
    const runActions = okRunActions();

    const result = buildTableFromSource(runActions, schema, childSource, [
      parentSource,
      childSource,
    ]);

    expect(result.tableName).toBe("opais_npiNumbers");
    const actions = runActions.mock.calls[0]?.[0] as Array<Record<string, unknown>>;
    expect(actions[1]).toEqual({
      op: "add_relationship",
      from_table: "opais",
      from_field: "_rowId_2",
      to_table: "opais_npiNumbers",
      to_field: "_parentId_2",
      cardinality: "1:N",
    });
  });

  it("backfills the link when the parent is built after the child", () => {
    const schema: Schema = {
      tables: [table("t-c", "opais_npiNumbers", ["npiNumber", "_parentId_2"])],
      relationships: [],
    };
    const runActions = okRunActions();

    const result = buildTableFromSource(runActions, schema, parentSource, [
      parentSource,
      childSource,
    ]);

    expect(result.tableName).toBe("opais");
    const actions = runActions.mock.calls[0]?.[0] as Array<Record<string, unknown>>;
    expect(actions[1]).toEqual({
      op: "add_relationship",
      from_table: "opais",
      from_field: "_rowId_2",
      to_table: "opais_npiNumbers",
      to_field: "_parentId_2",
      cardinality: "1:N",
    });
  });
});
