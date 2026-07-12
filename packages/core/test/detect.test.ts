import { describe, expect, it } from "vitest";

import type { FieldStats, Source, SourceField } from "../src/parse/types.js";
import {
  detectFormatMismatch,
  detectFunctionalDependencies,
  detectJoinKeys,
  detectPrimaryKeys,
  detectCompositeKeys,
  detectSemanticTypes,
  detectValueSets,
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

describe("detectValueSets", () => {
  /** A field whose distinct value set is fully captured, as parse would produce. */
  function enumField(
    name: string,
    type: SourceField["type"],
    distinctValues: string[],
    nonEmpty: number,
  ): SourceField {
    return {
      name,
      type,
      samples: distinctValues.slice(0, 5),
      distinctValues,
      stats: { nonEmpty, distinct: distinctValues.length, blank: 0 },
    };
  }

  it("detects a repeating status column as a closed value set", () => {
    const src = source("s1", "orders.csv", [
      enumField("status", "text", ["shipped", "pending", "cancelled"], 200),
    ]);

    const candidates = detectValueSets([src]);

    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({
      sourceName: "orders.csv",
      field: "status",
      distinct: 3,
      nonEmpty: 200,
      suggestion: "enum",
    });
    expect(candidates[0]?.values).toEqual(["cancelled", "pending", "shipped"]);
  });

  it("suggests lookup for descriptive name-like values", () => {
    const src = source("s1", "orders.csv", [
      enumField(
        "shipping_method",
        "text",
        ["Standard Ground Shipping", "Express Overnight Delivery", "In-Store Pickup"],
        150,
      ),
    ]);

    expect(detectValueSets([src])[0]?.suggestion).toBe("lookup");
  });

  it("ignores high-cardinality columns, booleans, and columns without repeats", () => {
    const src = source("s1", "orders.csv", [
      // Unique identifier: distinct === nonEmpty, ratio 1.
      enumField("order_id", "text", ["a", "b", "c", "d", "e", "f"], 6),
      // Boolean columns are already modeled by their type.
      enumField("is_paid", "bool", ["true", "false"], 100),
    ]);

    expect(detectValueSets([src])).toEqual([]);
  });

  it("skips fields without stats or with too few rows", () => {
    const src = source("s1", "orders.csv", [
      field("status", "text", ["a", "b"]),
      enumField("tiny", "text", ["x"], 2),
    ]);

    expect(detectValueSets([src])).toEqual([]);
  });
});

describe("detectSemanticTypes", () => {
  function valuesField(
    name: string,
    type: SourceField["type"],
    distinctValues: string[],
  ): SourceField {
    return { name, type, samples: distinctValues.slice(0, 5), distinctValues };
  }

  it("detects emails, urls, and uuids from values alone", () => {
    const src = source("s1", "users.csv", [
      valuesField("contact", "text", ["a@x.com", "b@y.org", "c@z.net"]),
      valuesField("website", "text", ["https://a.com", "http://b.org", "https://c.io/x"]),
      valuesField("token", "text", [
        "6fa459ea-ee8a-3ca4-894e-db77e160355e",
        "16fd2706-8baf-433b-82eb-8c7fada847da",
        "886313e1-3b8a-5372-9b90-0c9aee199e5d",
      ]),
    ]);

    const semantics = detectSemanticTypes([src]).map((finding) => [
      finding.field,
      finding.semantic,
    ]);

    expect(semantics).toEqual([
      ["contact", "email"],
      ["token", "uuid"],
      ["website", "url"],
    ]);
  });

  it("detects latitude/longitude pairs only with a corroborating name", () => {
    const src = source("s1", "stores.csv", [
      valuesField("latitude", "numeric", ["40.7128", "34.0522", "-33.8688"]),
      valuesField("lng", "numeric", ["-74.0060", "-118.2437", "151.2093"]),
      // Same value shapes but a neutral name — must NOT classify.
      valuesField("score", "numeric", ["40.7", "34.0", "-33.8"]),
    ]);

    const findings = detectSemanticTypes([src]);

    expect(findings).toEqual([
      expect.objectContaining({ field: "latitude", semantic: "latitude" }),
      expect.objectContaining({ field: "lng", semantic: "longitude" }),
    ]);
  });

  it("requires a name hint for zips and phones so plain ids stay unclassified", () => {
    const src = source("s1", "orgs.csv", [
      valuesField("zip_code", "text", ["07030", "10001", "94103"]),
      valuesField("org_id", "text", ["07031", "10002", "94104"]),
      valuesField("phone", "text", ["(212) 555-0100", "+1 415-555-0101", "646.555.0102"]),
    ]);

    const semantics = detectSemanticTypes([src]).map((finding) => [
      finding.field,
      finding.semantic,
    ]);

    expect(semantics).toEqual([
      ["phone", "phone"],
      ["zip_code", "postal_code"],
    ]);
  });

  it("stays quiet below the match-rate or value-count thresholds", () => {
    const src = source("s1", "misc.csv", [
      // Only 2 of 4 values are emails — below the 0.9 match rate.
      valuesField("notes", "text", ["a@x.com", "call later", "b@y.org", "n/a"]),
      // Too few values to judge.
      valuesField("maybe_email", "text", ["a@x.com", "b@y.org"]),
    ]);

    expect(detectSemanticTypes([src])).toEqual([]);
  });
});

describe("detectCompositeKeys", () => {
  /** Build a source whose fields and stats are derived from explicit row tuples. */
  function tupleSource(name: string, fieldNames: string[], rows: string[][]): Source {
    const fields = fieldNames.map((fieldName, index) => {
      const values = rows.map((row) => row[index] ?? "");
      const distinct = new Set(values.filter((value) => value !== "")).size;
      const nonEmpty = values.filter((value) => value !== "").length;
      return {
        name: fieldName,
        type: "text" as const,
        samples: values.slice(0, 5),
        stats: { nonEmpty, distinct, blank: values.length - nonEmpty },
      };
    });
    return { id: name, name, kind: "csv", fields, sampleRows: rows };
  }

  /** 8 orders × 3 line numbers: the classic line-item grain. */
  function orderLineRows(): string[][] {
    const rows: string[][] = [];
    for (let order = 1; order <= 8; order += 1) {
      for (let line = 1; line <= 3; line += 1) {
        // amount repeats within an order so (order_id, amount) is NOT unique together.
        rows.push([`O${order}`, String(line), line === 2 ? "20.00" : "10.00"]);
      }
    }
    return rows;
  }

  it("finds the pair that is unique together while neither is unique alone", () => {
    const source = tupleSource(
      "order_lines.csv",
      ["order_id", "line_no", "amount"],
      orderLineRows(),
    );

    const candidates = detectCompositeKeys([source]);

    expect(candidates).toHaveLength(1);
    expect(candidates[0]).toMatchObject({
      sourceName: "order_lines.csv",
      fields: ["order_id", "line_no"],
      rows: 24,
    });
    expect(candidates[0]?.reason).toContain("unique together");
  });

  it("excludes columns that are unique alone — a single-column PK suffices", () => {
    const rows = Array.from({ length: 24 }, (_, index) => [
      `row-${index}`, // unique alone
      String(index % 3),
      String(index % 8),
    ]);
    const source = tupleSource("t.csv", ["id", "a", "b"], rows);

    // (a, b) covers only 24 of 24 combos? 3×8 = 24 distinct pairs here — that IS unique
    // together, and neither a nor b is unique alone, so it's the only legitimate candidate;
    // nothing may pair with the standalone-unique id column.
    const candidates = detectCompositeKeys([source]);
    expect(candidates.every((candidate) => !candidate.fields.includes("id"))).toBe(true);
  });

  it("rejects a nearly-unique column even when its duplicates miss the tuple sample", () => {
    // email has ONE duplicate in the full 1000-row window (stats say duplicated) but is
    // fully unique within the 30 sampled tuples. Judging eligibility on the full window
    // alone would let (email, country) read as "unique together" — a spurious composite
    // key for what is effectively a single-column key.
    const rows = Array.from({ length: 30 }, (_, index) => [
      `user${index}@x.com`,
      index % 2 === 0 ? "US" : "CA",
    ]);
    const source: Source = {
      id: "s1",
      name: "users.csv",
      kind: "csv",
      fields: [
        {
          name: "email",
          type: "text",
          samples: ["user0@x.com"],
          stats: { nonEmpty: 1000, distinct: 999, blank: 0 },
        },
        {
          name: "country",
          type: "text",
          samples: ["US", "CA"],
          stats: { nonEmpty: 1000, distinct: 2, blank: 0 },
        },
      ],
      sampleRows: rows,
    };

    expect(detectCompositeKeys([source])).toEqual([]);
  });

  it("excludes columns containing null tokens — keys must be non-null", () => {
    const rows = orderLineRows();
    const withNull = rows.map((row, index) =>
      index === 5 ? ["N/A", row[1] ?? "", row[2] ?? ""] : row,
    );
    const source = tupleSource("order_lines.csv", ["order_id", "line_no", "amount"], withNull);

    expect(
      detectCompositeKeys([source]).some((candidate) => candidate.fields.includes("order_id")),
    ).toBe(false);
  });

  it("yields nothing without sampleRows or below the row threshold", () => {
    const noTuples = tupleSource("a.csv", ["x", "y"], orderLineRows());
    delete (noTuples as { sampleRows?: string[][] }).sampleRows;
    expect(detectCompositeKeys([noTuples])).toEqual([]);

    const tiny = tupleSource(
      "b.csv",
      ["order_id", "line_no", "amount"],
      orderLineRows().slice(0, 6),
    );
    expect(detectCompositeKeys([tiny])).toEqual([]);
  });
});

describe("detectFunctionalDependencies", () => {
  /** Build a source whose fields and stats are derived from explicit row tuples. */
  function tupleSource(name: string, fieldNames: string[], rows: string[][]): Source {
    const fields = fieldNames.map((fieldName, index) => {
      const values = rows.map((row) => row[index] ?? "");
      const distinct = new Set(values.filter((value) => value !== "")).size;
      const nonEmpty = values.filter((value) => value !== "").length;
      return {
        name: fieldName,
        type: "text" as const,
        samples: values.slice(0, 5),
        stats: { nonEmpty, distinct, blank: values.length - nonEmpty },
      };
    });
    return { id: name, name, kind: "csv", fields, sampleRows: rows };
  }

  /**
   * A flattened orders export: 8 customers × 3 orders. customer_id fixes name and email
   * (the extraction candidate); order_id is unique; amount varies within a customer.
   */
  function ordersRows(): string[][] {
    const rows: string[][] = [];
    let order = 0;
    for (let customer = 1; customer <= 8; customer += 1) {
      for (let n = 1; n <= 3; n += 1) {
        order += 1;
        rows.push([
          `O${order}`,
          `C${customer}`,
          `Customer ${customer}`,
          `c${customer}@x.com`,
          String(order * 10),
        ]);
      }
    }
    return rows;
  }

  const ORDER_FIELDS = ["order_id", "customer_id", "customer_name", "customer_email", "amount"];

  it("finds the customer columns determined by customer_id in a flattened orders export", () => {
    const candidates = detectFunctionalDependencies([
      tupleSource("orders.csv", ORDER_FIELDS, ordersRows()),
    ]);

    const byCustomerId = candidates.find((candidate) => candidate.determinant === "customer_id");
    expect(byCustomerId).toMatchObject({
      sourceName: "orders.csv",
      dependents: ["customer_name", "customer_email"],
      rows: 24,
      groups: 8,
    });
    expect(byCustomerId?.reason).toContain("extraction candidate");
  });

  it("never uses a unique column as determinant, and never reports a constant as dependent", () => {
    const rows = ordersRows().map((row) => [...row, "always-the-same"]);
    const candidates = detectFunctionalDependencies([
      tupleSource("orders.csv", [...ORDER_FIELDS, "constant"], rows),
    ]);

    expect(candidates.some((candidate) => candidate.determinant === "order_id")).toBe(false);
    expect(candidates.some((candidate) => candidate.determinant === "constant")).toBe(false);
    expect(candidates.every((candidate) => !candidate.dependents.includes("constant"))).toBe(true);
  });

  it("rejects a determinant that is near-unique over the full scan window", () => {
    // email repeats within the 24 sampled tuples but the full-window stats say it is
    // effectively unique — grouping by it would be coincidental, not structural.
    const rows = ordersRows();
    const source = tupleSource("orders.csv", ORDER_FIELDS, rows);
    const email = source.fields[3]!;
    email.stats = { nonEmpty: 1000, distinct: 1000, blank: 0 };

    const candidates = detectFunctionalDependencies([source]);
    expect(candidates.some((candidate) => candidate.determinant === "customer_email")).toBe(false);
    // The structural dependency is still found from the other determinants.
    expect(candidates.some((candidate) => candidate.determinant === "customer_id")).toBe(true);
  });

  it("skips columns with blanks as determinants", () => {
    const rows = ordersRows().map((row, index) =>
      index === 5 ? [row[0]!, "", row[2]!, row[3]!, row[4]!] : row,
    );
    const candidates = detectFunctionalDependencies([
      tupleSource("orders.csv", ORDER_FIELDS, rows),
    ]);
    expect(candidates.some((candidate) => candidate.determinant === "customer_id")).toBe(false);
  });

  it("caps candidates per source and orders the strongest extraction first", () => {
    const candidates = detectFunctionalDependencies(
      [tupleSource("orders.csv", ORDER_FIELDS, ordersRows())],
      { maxPerSource: 1 },
    );
    expect(candidates).toHaveLength(1);
    // customer_id/name/email form a bijection; each determines the other two. The cap keeps
    // the alphabetically-first of the equally-scored determinants — deterministic output.
    expect(candidates[0]?.dependents).toHaveLength(2);
  });

  it("yields nothing without sampleRows or below the row threshold", () => {
    const noTuples = tupleSource("orders.csv", ORDER_FIELDS, ordersRows());
    delete (noTuples as { sampleRows?: string[][] }).sampleRows;
    expect(detectFunctionalDependencies([noTuples])).toEqual([]);

    const tiny = tupleSource("orders.csv", ORDER_FIELDS, ordersRows().slice(0, 6));
    expect(detectFunctionalDependencies([tiny])).toEqual([]);
  });

  it("tolerates occasional blank dependent cells without dropping the dependency", () => {
    // One sampled row is missing the email for a customer whose email appears elsewhere —
    // dirty data, not a conflicting value; customer_id → customer_email must still hold.
    const rows = ordersRows().map((row, index) =>
      index === 4 ? [row[0]!, row[1]!, row[2]!, "", row[4]!] : row,
    );
    const candidates = detectFunctionalDependencies([
      tupleSource("orders.csv", ORDER_FIELDS, rows),
    ]);

    const byCustomerId = candidates.find((candidate) => candidate.determinant === "customer_id");
    expect(byCustomerId?.dependents).toContain("customer_email");
  });

  it("never reports a mostly-blank column as a dependent, even when its rare values agree", () => {
    // A sparse notes-like column: one consistent value per customer, blank everywhere else.
    // Skipping blanks makes it trivially "hold" — the coverage gate must reject it.
    const rows = ordersRows().map((row, index) => {
      const customer = Math.floor(index / 3) + 1;
      const note = index % 3 === 0 ? `note-${customer}` : "";
      return [...row, note];
    });
    const candidates = detectFunctionalDependencies([
      tupleSource("orders.csv", [...ORDER_FIELDS, "note"], rows),
    ]);

    expect(candidates.every((candidate) => !candidate.dependents.includes("note"))).toBe(true);
  });
});

/* PR-2 (GAP B): a real FK is a subset relationship — high one-way containment, low symmetric
 * Jaccard. The containment path admits it; a distinctness floor keeps enums out. */
describe("detectJoinKeys containment path", () => {
  it("surfaces an FK-shaped pair (child ⊆ large parent) that Jaccard alone rejects", () => {
    // 20 child keys fully contained in a 100-key parent: Jaccard 20/100 = 0.2 < 0.3, but
    // containment(child) = 1.0 — the exact shape of a 1:N FK into a large dimension.
    const parentIds = Array.from({ length: 100 }, (_, i) => `id_${i}`);
    const childIds = parentIds.slice(0, 20);
    const child = source("c", "child.csv", [
      { name: "parent_ref", type: "text", samples: childIds.slice(0, 5), distinctValues: childIds },
    ]);
    const parent = source("p", "parent.csv", [
      { name: "id", type: "text", samples: parentIds.slice(0, 5), distinctValues: parentIds },
    ]);

    const candidates = detectJoinKeys([child, parent]);

    expect(candidates).toHaveLength(1);
    expect(candidates[0]?.containmentLeft).toBe(1);
    expect(candidates[0]?.containmentRight).toBeCloseTo(0.2);
    expect(candidates[0]?.normalizedOverlap).toBeCloseTo(0.2);
  });

  it("does NOT surface a small enum fully contained in a big column (distinctness floor)", () => {
    // A 3-value enum has containment 1.0 and 3 shared values — the floor must block it.
    const enumValues = ["active", "closed", "pending"];
    const bigColumn = [...enumValues, ...Array.from({ length: 100 }, (_, i) => `word_${i}`)];
    const a = source("a", "a.csv", [
      { name: "status", type: "text", samples: enumValues, distinctValues: enumValues },
    ]);
    const b = source("b", "b.csv", [
      { name: "notes", type: "text", samples: bigColumn.slice(0, 5), distinctValues: bigColumn },
    ]);

    expect(detectJoinKeys([a, b])).toEqual([]);
  });

  it("rejects the threshold pair on BOTH gates", () => {
    // {1,2,3,4} vs {1,99,98,97}: sharedValues=1 < 2 (Jaccard path) AND max containment
    // 0.25 < 0.4 (containment path) — verify explicitly, not via minShared alone.
    const a = source("a", "a.csv", [field("x", "int", ["1", "2", "3", "4"])]);
    const b = source("b", "b.csv", [field("y", "int", ["1", "99", "98", "97"])]);

    expect(detectJoinKeys([a, b])).toEqual([]);
  });

  it("ranks a containment-admitted FK by its containment, not its diluted Jaccard", () => {
    const parentIds = Array.from({ length: 100 }, (_, i) => `id_${i}`);
    const childIds = parentIds.slice(0, 20);
    const noise = ["n1", "n2", "n3", "n4", ...Array.from({ length: 6 }, (_, i) => `m${i}`)];
    const partialNoise = ["n1", "n2", "n3", "n4", ...Array.from({ length: 6 }, (_, i) => `x${i}`)];
    const left = source("l", "left.csv", [
      { name: "parent_ref", type: "text", samples: childIds.slice(0, 5), distinctValues: childIds },
      { name: "tag", type: "text", samples: noise.slice(0, 5), distinctValues: noise },
    ]);
    const right = source("r", "right.csv", [
      { name: "id", type: "text", samples: parentIds.slice(0, 5), distinctValues: parentIds },
      {
        name: "tag",
        type: "text",
        samples: partialNoise.slice(0, 5),
        distinctValues: partialNoise,
      },
    ]);

    const candidates = detectJoinKeys([left, right], { minOverlap: 0.25 });

    // tag↔tag has Jaccard 4/16 = 0.25 (admitted) but strength 0.4; the FK pair's strength is
    // its containment 1.0 — it must sort first despite Jaccard 0.2.
    expect(candidates.map((c) => `${c.left.field}->${c.right.field}`)).toEqual([
      "parent_ref->id",
      "tag->tag",
    ]);
  });

  it("prefers the wide joinValues set over the capped distinctValues window", () => {
    // distinctValues pretends the columns are disjoint; joinValues shows full containment.
    const wide = Array.from({ length: 50 }, (_, i) => `k${i}`);
    const a = source("a", "a.csv", [
      {
        name: "ref",
        type: "text",
        samples: wide.slice(0, 5),
        distinctValues: ["zz1", "zz2", "zz3"],
        joinValues: wide,
      },
    ]);
    const b = source("b", "b.csv", [
      { name: "key", type: "text", samples: wide.slice(0, 5), distinctValues: wide },
    ]);

    const [candidate] = detectJoinKeys([a, b]);
    expect(candidate?.sharedValues).toBe(50);
    expect(candidate?.containmentLeft).toBe(1);
  });
});

/* PR-0 boundary fixture (§6 boundary_mini): the only test that fails if the wide discovery
 * pass regresses to the 1000-value scan window. */
describe("sampling boundary (boundary_mini)", () => {
  // 1500 keys; the child holds keys 0..599 (containment 600/600 = 1.0 ≥ τ over the full
  // column). An even 1000-of-1500 sample of the parent keeps ~2/3 of the child's keys —
  // engineered so the capped window still *finds* the pair but a stronger criterion holds
  // only uncapped: full containment of the child.
  const parentKeys = Array.from({ length: 1500 }, (_, i) => `key_${String(i).padStart(4, "0")}`);
  const childKeys = parentKeys.slice(0, 600);

  const csvFor = (header: string, values: string[]): string => [header, ...values].join("\n");

  it("misses full containment at the 1000-value cap but sees it after the wide pass", async () => {
    const { parseCsv } = await import("../src/index.js");
    const parent = parseCsv(csvFor("id", parentKeys), "parent.csv");
    const child = parseCsv(csvFor("parent_ref", childKeys), "child.csv");

    // (a) Red baseline for the pre-PR-0 behavior: the capped windows alone understate the
    // relationship — the child's true 100% containment is NOT observable at the cap.
    const dropWide = (entry: Source): Source => ({
      ...entry,
      fields: entry.fields.map((fieldEntry) => {
        const copy = { ...fieldEntry };
        delete copy.joinValues;
        return copy;
      }),
    });
    const cappedChild = dropWide(child);
    const cappedParent = dropWide(parent);
    const [cappedCandidate] = detectJoinKeys([cappedChild, cappedParent]);
    expect(cappedCandidate?.containmentLeft ?? 0).toBeLessThan(1);

    // (b) With the wide pass the full-file figure is exact: every child key is contained.
    const [candidate] = detectJoinKeys([child, parent]);
    expect(candidate?.containmentLeft).toBe(1);
    expect(candidate?.sharedValues).toBe(600);
  });
});
