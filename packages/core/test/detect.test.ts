import { describe, expect, it } from "vitest";

import type { Source, SourceField } from "../src/parse/types.js";
import { detectFormatMismatch, detectJoinKeys } from "../src/detect/index.js";

function field(name: string, type: SourceField["type"], samples: string[]): SourceField {
  return { name, type, samples };
}

function source(id: string, name: string, fields: SourceField[]): Source {
  return { id, name, kind: "csv", fields };
}

describe("detectFormatMismatch", () => {
  it("flags leading zeros when one side is zero-padded (HRSA vs OPAIS)", () => {
    const hrsa = field("grant_number", "text", ["01234", "00078", "05500"]);
    const opais = field("grant_number", "int", ["1234", "78", "5500"]);

    const mismatch = detectFormatMismatch(hrsa, opais);

    expect(mismatch).not.toBeNull();
    expect(mismatch?.issues).toContain("leading_zeros");
    // text vs int columns that share values once normalized
    expect(mismatch?.issues).toContain("numeric_vs_text");
  });

  it("flags case differences", () => {
    const left = field("code", "text", ["AB-1", "CD-2", "EF-3"]);
    const right = field("code", "text", ["ab-1", "cd-2", "ef-3"]);

    const mismatch = detectFormatMismatch(left, right);

    expect(mismatch?.issues).toEqual(["case_mismatch"]);
    expect(mismatch?.note).toBe("normalize letter case");
  });

  it("flags surrounding whitespace", () => {
    const left = field("sku", "text", [" A1 ", "B2", "C3 "]);
    const right = field("sku", "text", ["A1", "B2", "C3"]);

    expect(detectFormatMismatch(left, right)?.issues).toEqual(["whitespace"]);
  });

  it("returns null when columns already match", () => {
    const left = field("id", "int", ["1", "2", "3"]);
    const right = field("ref", "int", ["1", "2", "3"]);

    expect(detectFormatMismatch(left, right)).toBeNull();
  });

  it("returns null when columns share nothing even after normalization", () => {
    const left = field("a", "text", ["alpha", "beta"]);
    const right = field("b", "text", ["x", "y"]);

    expect(detectFormatMismatch(left, right)).toBeNull();
  });
});

describe("detectJoinKeys", () => {
  it("proposes a normalization-required join across sources", () => {
    const hrsa = source("s1", "hrsa.csv", [
      field("grant_number", "text", ["01234", "00078", "05500", "09001"]),
      field("city", "text", ["Austin", "Dallas", "Reno", "Miami"]),
    ]);
    const opais = source("s2", "opais.csv", [
      field("grant_number", "int", ["1234", "78", "5500", "9001"]),
      field("status", "text", ["active", "active", "closed", "active"]),
    ]);

    const candidates = detectJoinKeys([hrsa, opais]);

    expect(candidates).toHaveLength(1);
    const [candidate] = candidates;
    expect(candidate?.left.field).toBe("grant_number");
    expect(candidate?.right.field).toBe("grant_number");
    expect(candidate?.sharedValues).toBe(4);
    expect(candidate?.normalizedOverlap).toBe(1);
    expect(candidate?.rawOverlap).toBe(0);
    expect(candidate?.requiresNormalization).toBe(true);
    expect(candidate?.formatMismatch?.issues).toContain("leading_zeros");
  });

  it("proposes a clean join with no normalization when formats already match", () => {
    const orders = source("o", "orders.csv", [field("customer_id", "int", ["1", "2", "3", "4"])]);
    const customers = source("c", "customers.csv", [field("id", "int", ["1", "2", "3", "4"])]);

    const [candidate] = detectJoinKeys([orders, customers]);

    expect(candidate?.requiresNormalization).toBe(false);
    expect(candidate?.formatMismatch).toBeNull();
    expect(candidate?.normalizedOverlap).toBe(1);
  });

  it("ignores pairs below the overlap threshold", () => {
    const a = source("a", "a.csv", [field("x", "int", ["1", "2", "3", "4"])]);
    const b = source("b", "b.csv", [field("y", "int", ["1", "99", "98", "97"])]);

    expect(detectJoinKeys([a, b])).toEqual([]);
  });

  it("is deterministic and sorted by normalized overlap", () => {
    const a = source("a", "a.csv", [
      field("strong", "int", ["1", "2", "3", "4"]),
      field("weak", "int", ["1", "2", "50", "60"]),
    ]);
    const b = source("b", "b.csv", [field("key", "int", ["1", "2", "3", "4"])]);

    const candidates = detectJoinKeys([a, b], { minSharedValues: 2, minOverlap: 0.2 });

    expect(candidates.map((c) => c.left.field)).toEqual(["strong", "weak"]);
    expect(detectJoinKeys([a, b], { minOverlap: 0.2 })).toEqual(candidates);
  });
});
