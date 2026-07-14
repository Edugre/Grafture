import { describe, expect, it } from "vitest";

import type { FieldStats, Source, SourceField } from "../src/parse/types.js";
import {
  classifyRelationship,
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
    expect(mismatch?.note).toBe("normalize letter case (+3 matches)");
    expect(mismatch?.gains).toEqual({ case_mismatch: 3 });
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

/* PR-6 (GAP F): grain is judged against the modeled entity, not the flat source column. */
describe("schema-aware grain", () => {
  const dup: FieldStats = { nonEmpty: 24, distinct: 8, blank: 0 };

  it("inferGrain treats an entity-key side as 'one' despite flat-file repeats", () => {
    const orgKey = statField("org_id", "text", ["H1", "H2", "H3"], dup);
    const factKey = statField("grant", "text", ["H1", "H2", "H3"], dup);

    // Raw stats say both repeat → N:M; the key context corrects the modeled side.
    expect(inferGrain(orgKey, factKey)).toBe("N:M");
    expect(inferGrain(orgKey, factKey, { leftIsEntityKey: true })).toBe("1:N");
    expect(inferGrain(orgKey, factKey, { rightIsEntityKey: true })).toBe("N:1");
  });

  it("inferGrain promotes NEITHER side when both key an entity — a shared parent, not a 1:1", () => {
    // The real HRSA↔OPAIS shape: `Health Center Number` determines the org columns in the CSV
    // and `grantNumber` determines the grant columns in the JSON, so both are entity keys and
    // both repeat. Promoting both would read 1:1 — a fabricated cardinality. They key the SAME
    // entity, so the honest grain is N:M and the classifier calls it `shared_parent`.
    const hcn = statField("Health Center Number", "text", ["H1", "H2"], dup);
    const grant = statField("grantNumber", "text", ["H1", "H2"], dup);

    expect(inferGrain(hcn, grant, { leftIsEntityKey: true, rightIsEntityKey: true })).toBe("N:M");
  });

  it("inferGrain never promotes an entity key against a genuinely unique side", () => {
    // The universal FK convention: customers.customer_id is a real PK, orders.customer_id is the
    // child's repeating FK. A canvas PK named `customer_id` flags the CHILD column by name — but
    // raw uniqueness on the parent outranks that, so the grain stays N:1 and does not read 1:1.
    const childFk = statField("customer_id", "text", ["c1", "c2"], dup);
    const parentPk = statField("customer_id", "text", ["c1", "c2"], {
      nonEmpty: 8,
      distinct: 8,
      blank: 0,
    });

    expect(inferGrain(childFk, parentPk, { leftIsEntityKey: true })).toBe("N:1");
    expect(inferGrain(childFk, parentPk, { leftIsEntityKey: true, rightIsEntityKey: true })).toBe(
      "N:1",
    );
  });

  // 16 orgs: an entity key must clear the value-set cardinality ceiling (12), so an 8-value
  // An entity key is near-unique per row and repeats only because the file is denormalized. The
  // fixture mirrors the REAL cardinality the detector sees on the 18,855-row HRSA export, where
  // `Health Center Number` is 167 groups / 200 sampled rows = 0.835: here, 32 orgs across 40 rows
  // (8 of them appearing twice) = 0.8. An earlier 16-orgs-over-48-rows fixture sat at 0.33 —
  // below a US-state column's real ratio — and so could not tell an entity key from an enum.
  const orgIds = Array.from({ length: 32 }, (_, i) => `H8${i}`);
  const ORG_ROWS = 40;

  /** The denormalized HRSA CSV: the org key repeats across sites and determines the org columns. */
  function hrsaSource(): Source {
    const rows: string[][] = [];
    for (const [i, orgId] of orgIds.entries()) {
      rows.push([orgId, `Org ${i}`]);
    }
    // Eight orgs carry a second site, so the determinant repeats without becoming an enum.
    for (let i = 0; i < ORG_ROWS - orgIds.length; i += 1) {
      rows.push([orgIds[i] as string, `Org ${i}`]);
    }
    return {
      id: "h",
      name: "hrsa.csv",
      kind: "csv",
      rowCount: ORG_ROWS,
      fields: [
        {
          name: "Health Center Number",
          type: "text",
          samples: orgIds.slice(0, 5),
          distinctValues: orgIds,
          stats: { nonEmpty: ORG_ROWS, distinct: orgIds.length, blank: 0 },
        },
        {
          name: "Grantee Org Name",
          type: "text",
          samples: ["Org 0"],
          distinctValues: orgIds.map((_, i) => `Org ${i}`),
          stats: { nonEmpty: ORG_ROWS, distinct: orgIds.length, blank: 0 },
        },
      ],
      sampleRows: rows,
    };
  }

  it("detectJoinKeys grades an FD-determinant ↔ fact-key pair 1:N, not N:M (HRSA regression)", () => {
    // The org key *determines* the org-level columns — it keys the organization entity an FD
    // split would extract — so its join against the OPAIS grant column (genuinely repeating:
    // many covered entities per grant, and NOT itself a determinant) is 1:N, not N:M.
    const opais = source("o", "opais.json", [
      {
        name: "grantNumber",
        type: "text",
        samples: orgIds.slice(0, 5),
        distinctValues: orgIds,
        stats: { nonEmpty: 80, distinct: orgIds.length, blank: 0 },
      },
    ]);

    const candidate = detectJoinKeys([hrsaSource(), opais]).find(
      (entry) => entry.left.field === "Health Center Number" && entry.right.field === "grantNumber",
    );

    expect(candidate).toBeDefined();
    expect(candidate?.grain).toBe("1:N");
    // Full mutual containment, no blanks over the whole file → an enforceable FK.
    expect(candidate?.verdict).toBe("enforced_fk");
  });

  it("calls a both-sides-determinant pair shared_parent, not 1:1 (the real HRSA↔OPAIS shape)", () => {
    // Unlike the case above, OPAIS here carries its own row tuples and `grantNumber` determines
    // the grant-level columns denormalized into it. Both columns now key an entity and both
    // repeat — they key the SAME entity. Promoting both would fabricate a 1:1.
    const opaisRows: string[][] = [];
    for (const [i, orgId] of orgIds.entries()) {
      opaisRows.push([orgId, `Grant ${i}`]);
    }
    for (let i = 0; i < ORG_ROWS - orgIds.length; i += 1) {
      opaisRows.push([orgIds[i] as string, `Grant ${i}`]);
    }
    const opais: Source = {
      id: "o",
      name: "opais.json",
      kind: "json",
      rowCount: ORG_ROWS,
      fields: [
        {
          name: "grantNumber",
          type: "text",
          samples: orgIds.slice(0, 5),
          distinctValues: orgIds,
          stats: { nonEmpty: ORG_ROWS, distinct: orgIds.length, blank: 0 },
        },
        {
          name: "grantName",
          type: "text",
          samples: ["Grant 0"],
          distinctValues: orgIds.map((_, i) => `Grant ${i}`),
          stats: { nonEmpty: ORG_ROWS, distinct: orgIds.length, blank: 0 },
        },
      ],
      sampleRows: opaisRows,
    };

    const candidate = detectJoinKeys([hrsaSource(), opais]).find(
      (entry) => entry.left.field === "Health Center Number" && entry.right.field === "grantNumber",
    );

    expect(candidate?.grain).toBe("N:M");
    expect(candidate?.verdict).toBe("shared_parent");
    expect(candidate?.verdictReason).toContain("key the same entity");
  });

  it("does not treat a REAL ~50-value state column as an entity key (geographic enum)", () => {
    // The case an absolute cardinality floor cannot catch: a US-state column has ~50 distinct
    // values — as many as a small entity table — and determines state_name/region, so it is a
    // genuine FD determinant. On the real HRSA export `Site State Abbreviation` is 46 groups over
    // 200 sampled rows (ratio 0.23), and both HRSA and OPAIS carry such address blocks. Promoting
    // them makes an incidental state-code match read as a relationship between the two files.
    const states = Array.from({ length: 50 }, (_, i) => `S${i}`);
    /** 50 states across 200 rows = ratio 0.25, matching the real column. */
    function addressBlock(id: string, name: string, dependent: string): Source {
      const rows: string[][] = [];
      for (let i = 0; i < 200; i += 1) {
        const code = states[i % states.length] as string;
        rows.push([code, `${code} ${dependent}`]);
      }
      return {
        id,
        name,
        kind: "csv",
        rowCount: 200,
        fields: [
          {
            name: "state",
            type: "text",
            samples: states.slice(0, 5),
            distinctValues: states,
            stats: { nonEmpty: 200, distinct: 50, blank: 0 },
          },
          {
            name: dependent,
            type: "text",
            samples: [`S0 ${dependent}`],
            distinctValues: states.map((code) => `${code} ${dependent}`),
            stats: { nonEmpty: 200, distinct: 50, blank: 0 },
          },
        ],
        sampleRows: rows,
      };
    }

    const candidate = detectJoinKeys([
      addressBlock("l", "hrsa_sites.csv", "state_name"),
      addressBlock("r", "opais_entities.json", "region"),
    ]).find((entry) => entry.left.field === "state" && entry.right.field === "state");

    // Both sides are determinants with identical key spaces. Before the repeat-ratio gate both
    // were promoted to entity keys, so this pair read as a spurious "extract a shared state
    // entity". It is an enum match: neither side keys an entity.
    expect(candidate?.verdict).not.toBe("shared_parent");
    expect(candidate?.grain).toBe("N:M");
  });

  it("does not treat a low-cardinality determinant as an entity key (enum floor)", () => {
    // `state` determines `state_name`, so it is an FD determinant — but with 5 values it is a
    // lookup, not an entity whose key should flip a join's grain. Both sides must stay "many".
    const states = ["CA", "TX", "NY", "WA", "OR"];
    const rows: string[][] = [];
    for (let i = 0; i < 24; i += 1) {
      const code = states[i % states.length] ?? "CA";
      rows.push([code, `${code} full name`]);
    }
    const left: Source = {
      id: "l",
      name: "orders.csv",
      kind: "csv",
      rowCount: 24,
      fields: [
        {
          name: "state",
          type: "text",
          samples: states,
          distinctValues: states,
          stats: { nonEmpty: 24, distinct: 5, blank: 0 },
        },
        {
          name: "state_name",
          type: "text",
          samples: ["CA full name"],
          distinctValues: states.map((code) => `${code} full name`),
          stats: { nonEmpty: 24, distinct: 5, blank: 0 },
        },
      ],
      sampleRows: rows,
    };
    const right = source("r", "shipments.csv", [
      {
        name: "state",
        type: "text",
        samples: states,
        distinctValues: states,
        stats: { nonEmpty: 30, distinct: 5, blank: 0 },
      },
    ]);

    const candidate = detectJoinKeys([left, right]).find(
      (entry) => entry.left.field === "state" && entry.right.field === "state",
    );

    // Admitted via the Jaccard path (identical value sets), but graded honestly: an incidental
    // enum match, not an FK into a 5-row "state" entity.
    expect(candidate?.grain).toBe("N:M");
    expect(candidate?.verdict).toBe("junction");
  });
});

/* PR-7 (GAP G): raw probe numbers become a consistent modeling decision — enforceability and
 * representation are separate concerns. */
describe("classifyRelationship", () => {
  it("models the partial-coverage HRSA pair as a nullable FK, never a dropped edge", () => {
    const result = classifyRelationship({
      containmentLeft: 0.96,
      containmentRight: 0.42,
      grain: "1:N",
    });

    expect(result.verdict).toBe("nullable_fk");
    expect(result.reason).toContain("96%");
    expect(result.reason).toContain("still represent");
  });

  it("returns no_link for a near-zero-overlap decoy", () => {
    const result = classifyRelationship({
      containmentLeft: 0.02,
      containmentRight: 0.01,
      grain: "unknown",
    });
    expect(result.verdict).toBe("no_link");
  });

  it("returns junction for a well-covered N:M pair", () => {
    const result = classifyRelationship({
      containmentLeft: 0.8,
      containmentRight: 0.3,
      grain: "N:M",
    });
    expect(result.verdict).toBe("junction");
    expect(result.reason).toContain("junction table");
  });

  it("returns not_valid_fk for weak-but-nonzero coverage", () => {
    const result = classifyRelationship({
      containmentLeft: 0.2,
      containmentRight: 0.1,
      grain: "1:N",
    });
    expect(result.verdict).toBe("not_valid_fk");
  });

  it("returns enforced_fk only when every FK-side key resolves and none are blank", () => {
    const full = { containmentLeft: 1, containmentRight: 0.2, grain: "N:1" as const };

    expect(classifyRelationship({ ...full, nullRate: 0 }).verdict).toBe("enforced_fk");

    const withBlanks = classifyRelationship({ ...full, nullRate: 0.25 });
    expect(withBlanks.verdict).toBe("nullable_fk");
    expect(withBlanks.reason).toContain("25%");
  });

  it("carries the normalization note into the reason", () => {
    const result = classifyRelationship({
      containmentLeft: 0.9,
      containmentRight: 0.4,
      grain: "1:N",
      formatMismatch: {
        issues: ["leading_zeros"],
        gains: { leading_zeros: 39 },
        note: "strip leading zeros (+39 matches)",
      },
    });
    expect(result.reason).toContain("strip leading zeros (+39 matches)");
  });

  it("will not certify an enforceable FK from an unverified blank rate", () => {
    // `nullRate: undefined` means the blank count was never verified over the whole file (no
    // stats, or a 1000-row window on a 50k-row column). That is not the same as zero: a column
    // fully populated in its first 1000 rows can be 30% blank thereafter, and a NOT NULL FK
    // would be exported against data that violates it.
    const unverified = classifyRelationship({
      containmentLeft: 1,
      containmentRight: 0.2,
      grain: "N:1",
    });

    expect(unverified.verdict).toBe("nullable_fk");
    expect(unverified.reason).toContain("blank rate unverified");
  });

  it("will not certify an enforceable FK when the grain is unknown", () => {
    // No uniqueness evidence on either side (too few rows) — full containment alone is not an FK.
    const result = classifyRelationship({
      containmentLeft: 1,
      containmentRight: 0.2,
      grain: "unknown",
      nullRate: 0,
    });

    expect(result.verdict).toBe("nullable_fk");
    expect(result.reason).toContain("grain unknown");
  });

  it("condemns a pair only by the gate that admitted it", () => {
    const weak = { containmentLeft: 0.3, containmentRight: 0.1, grain: "1:N" as const };

    // Default gate (0.4): 30% is too weak for FK semantics.
    expect(classifyRelationship(weak).verdict).toBe("not_valid_fk");
    // A caller that deliberately lowered the admission gate must not have its own candidate
    // condemned by the classifier's default.
    expect(classifyRelationship({ ...weak, minContainment: 0.25 }).verdict).toBe("nullable_fk");
  });

  it("returns shared_parent when both sides key the same entity", () => {
    const result = classifyRelationship({
      containmentLeft: 0.96,
      containmentRight: 0.42,
      grain: "N:M",
      bothSidesKeyEntity: true,
    });

    expect(result.verdict).toBe("shared_parent");
    expect(result.reason).toContain("extract that entity");
    // The entity is often ALREADY on the canvas — a normalization split of one source commonly
    // extracts it before the cross-source link is considered. `classifyRelationship` is pure and
    // per-pair, so it cannot check canvas state: the reuse guard has to live in the instruction.
    expect(result.reason).toContain("reuse the existing table");
    expect(result.reason).toContain("do NOT add a second table");
  });
});

describe("detectFormatMismatch marginal gains", () => {
  it("quantifies each normalizer's marginal shared-value gain", () => {
    const hrsa = field("npi", "text", ["01234", "00078", "05500", "match"]);
    const opais = field("npi", "text", ["1234", "78", "5500", "match"]);

    const mismatch = detectFormatMismatch(hrsa, opais);

    // 1 raw match; stripping leading zeros recovers the other 3.
    expect(mismatch?.gains).toEqual({ leading_zeros: 3 });
    expect(mismatch?.note).toBe("strip leading zeros (+3 matches)");
  });
});
