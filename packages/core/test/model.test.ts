import { describe, expect, it } from "vitest";

import { emptySchema } from "../src/model.js";

describe("model", () => {
  it("creates an empty schema", () => {
    const schema = emptySchema();

    expect(schema.tables).toEqual([]);
    expect(schema.relationships).toEqual([]);
  });
});
