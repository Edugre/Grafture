import { describe, expect, it } from "vitest";

import { parseCsv, parseJson } from "../src/parse/index.js";

describe("parse", () => {
  it("parses CSV content into columns and rows", () => {
    const result = parseCsv("id,name\n1,Alice", "users.csv");

    expect(result.name).toBe("users.csv");
    expect(result.columns).toEqual(["id", "name"]);
    expect(result.rows).toHaveLength(1);
  });

  it("parses JSON array content", () => {
    const result = parseJson('[{"id":1,"name":"Alice"}]', "users.json");

    expect(result.columns).toEqual(["id", "name"]);
    expect(result.rows).toHaveLength(1);
  });
});
