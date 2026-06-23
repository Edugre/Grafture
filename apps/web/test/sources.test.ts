import { emptySchema } from "@schema-studio/core";
import { describe, expect, it, vi } from "vitest";

import { buildTableFromSource } from "../src/sources/buildFromSource.js";
import { detectSourceKind } from "../src/sources/detectKind.js";
import { tableNameFromFilename, uniqueTableName } from "../src/sources/tableName.js";

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

    expect(runActions).toHaveBeenCalledWith([
      {
        op: "add_table",
        name: "orgs",
        fields: [
          { name: "grant_number", type: "text" },
          { name: "count", type: "int" },
        ],
      },
    ]);
    expect(result.tableName).toBe("orgs");
  });
});
