import { describe, expect, it } from "vitest";

import type { FieldStats, Source, SourceField } from "../src/parse/types.js";
import {
  detectFormatMismatch,
  detectJoinKeys,
  detectPrimaryKeys,
  inferGrain,
} from "../src/detect/index.js";

function field(name: string, type: SourceField["type"], samples: string[]): SourceField {
  return { name, type, samples };
}

/** A field carrying value statistics — needed by the grain/PK detectors. */
function statField(
  name: string,
  type: SourceField["type"],
  samples: string[],
  stats: FieldStats,
): SourceField {
  return { name, type, samples, stats };
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

  it("compares the full distinct value set, not the 5-value display samples", () => {
    // Two files share an ID column but are sorted differently, so their first-5 display
    // samples are disjoint. The detectors must match on distinctValues to see the join.
    const ids = Array.from({ length: 100 }, (_, index) => String(index + 1));
    const forward: SourceField = {
      name: "customer_id",
      type: "int",
      samples: ids.slice(0, 5),
      distinctValues: ids,
    };
    const reversed: SourceField = {
      name: "id",
      type: "int",
      samples: ids.slice(-5),
      distinctValues: [...ids].reverse(),
    };

    const [candidate] = detectJoinKeys([
      source("o", "orders.csv", [forward]),
      source("c", "customers.csv", [reversed]),
    ]);

    expect(candidate?.normalizedOverlap).toBe(1);
    expect(candidate?.sharedValues).toBe(100);
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

  it("reports grain 'unknown' when sources carry no stats", () => {
    const orders = source("o", "orders.csv", [field("customer_id", "int", ["1", "2", "3", "4"])]);
    const customers = source("c", "customers.csv", [field("id", "int", ["1", "2", "3", "4"])]);

    const [candidate] = detectJoinKeys([orders, customers]);
    expect(candidate?.grain).toBe("unknown");
  });

  it("infers 1:N grain when the parent key is unique and the child repeats", () => {
    // customers.id is unique; orders.customer_id repeats — classic one-to-many.
    const orders = source("o", "orders.csv", [
      statField("customer_id", "int", ["1", "2", "3"], { nonEmpty: 6, distinct: 3, blank: 0 }),
    ]);
    const customers = source("c", "customers.csv", [
      statField("id", "int", ["1", "2", "3"], { nonEmpty: 4, distinct: 4, blank: 0 }),
    ]);

    const [candidate] = detectJoinKeys([orders, customers]);
    // left = orders.customer_id (duplicated), right = customers.id (unique) → N:1
    expect(candidate?.grain).toBe("N:1");
  });
});

describe("inferGrain", () => {
  const unique = (samples: string[]): FieldStats => ({
    nonEmpty: samples.length + 1,
    distinct: samples.length + 1,
    blank: 0,
  });
  const dup: FieldStats = { nonEmpty: 6, distinct: 3, blank: 0 };

  it("returns 1:1 when both sides are unique", () => {
    const left = statField("a", "int", ["1", "2", "3", "4"], unique(["1", "2", "3", "4"]));
    const right = statField("b", "int", ["1", "2", "3", "4"], unique(["1", "2", "3", "4"]));
    expect(inferGrain(left, right)).toBe("1:1");
  });

  it("returns 1:N when left is unique and right repeats", () => {
    const left = statField("a", "int", ["1", "2", "3", "4"], unique(["1", "2", "3", "4"]));
    const right = statField("b", "int", ["1", "2", "3"], dup);
    expect(inferGrain(left, right)).toBe("1:N");
  });

  it("returns N:M when both sides repeat", () => {
    const left = statField("a", "int", ["1", "2", "3"], dup);
    const right = statField("b", "int", ["1", "2", "3"], dup);
    expect(inferGrain(left, right)).toBe("N:M");
  });

  it("returns unknown when a side lacks stats or has too few rows", () => {
    const withStats = statField("a", "int", ["1", "2", "3", "4"], unique(["1", "2", "3", "4"]));
    const noStats = field("b", "int", ["1", "2", "3", "4"]);
    const tiny = statField("c", "int", ["1", "2"], { nonEmpty: 2, distinct: 2, blank: 0 });

    expect(inferGrain(withStats, noStats)).toBe("unknown");
    expect(inferGrain(withStats, tiny)).toBe("unknown");
  });
});

describe("detectPrimaryKeys", () => {
  it("proposes unique, non-null columns and skips columns with duplicates or blanks", () => {
    const customers = source("c", "customers.csv", [
      statField("id", "int", ["1", "2", "3"], { nonEmpty: 100, distinct: 100, blank: 0 }),
      statField("email", "text", ["a@x", "b@x"], { nonEmpty: 100, distinct: 98, blank: 0 }), // dupes
      statField("ssn", "text", ["111", "222"], { nonEmpty: 90, distinct: 90, blank: 10 }), // blanks
    ]);

    const candidates = detectPrimaryKeys([customers]);
    expect(candidates.map((c) => c.field)).toEqual(["id"]);
    expect(candidates[0]?.reason).toBe("unique and non-null across 100 rows");
  });

  it("ignores fields without stats and fields below the row threshold", () => {
    const small = source("s", "small.csv", [
      field("id", "int", ["1", "2", "3", "4"]), // no stats
      statField("code", "text", ["A", "B"], { nonEmpty: 2, distinct: 2, blank: 0 }), // too few rows
    ]);
    expect(detectPrimaryKeys([small])).toEqual([]);
  });

  it("surfaces id-like names first but admits any unique non-null column", () => {
    const source1 = source("s1", "s1.csv", [
      statField("title", "text", ["x", "y"], { nonEmpty: 50, distinct: 50, blank: 0 }),
      statField("user_id", "int", ["1", "2"], { nonEmpty: 50, distinct: 50, blank: 0 }),
    ]);

    const candidates = detectPrimaryKeys([source1]);
    expect(candidates.map((c) => c.field)).toEqual(["user_id", "title"]);
  });
});
