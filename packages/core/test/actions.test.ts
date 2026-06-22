import { describe, expect, it } from "vitest";

import { applyActions, emptySchema } from "../src/index.js";

describe("actions", () => {
  it("validates actions and returns the schema unchanged (stub)", () => {
    const schema = emptySchema();
    const result = applyActions(schema, []);

    expect(result).toEqual({ ok: true, schema });
  });

  it("rejects invalid actions", () => {
    const schema = emptySchema();
    const result = applyActions(schema, [{ type: "not_an_action" }]);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.length).toBeGreaterThan(0);
    }
  });
});
