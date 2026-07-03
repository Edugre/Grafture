import * as XLSX from "xlsx";
import { describe, expect, it } from "vitest";

import {
  MAX_SCAN_ROWS,
  TYPE_INFERENCE_RULES,
  TYPE_INFERENCE_THRESHOLD,
  ParseError,
  collectSamples,
  collectStats,
  inferType,
  parseCsv,
  parseJson,
  parseSource,
  parseXlsx,
  sampleScanRows,
} from "../src/parse/index.js";

function makeTestIds(prefix = "test-id"): () => string {
  let counter = 0;
  return () => `${prefix}-${++counter}`;
}

describe("inferType", () => {
  it("exports a table-driven rule list ending in text fallback", () => {
    expect(TYPE_INFERENCE_THRESHOLD).toBe(0.95);
    expect(TYPE_INFERENCE_RULES.map((rule) => rule.type)).toEqual([
      "bool",
      "int",
      "numeric",
      "timestamp",
      "date",
      "text",
    ]);
    expect(TYPE_INFERENCE_RULES.at(-1)?.matches([])).toBe(true);
  });

  it("infers int for integer columns", () => {
    expect(inferType(["1", "42", "-7", "0"])).toBe("int");
  });

  it("infers numeric when decimals are present", () => {
    expect(inferType(["1.5", "2.0", "3.25"])).toBe("numeric");
    expect(inferType(["1", "2.5", "3"])).toBe("numeric");
  });

  it("infers bool for true/false and yes/no", () => {
    expect(inferType(["true", "false", "True", "FALSE"])).toBe("bool");
    expect(inferType(["yes", "no", "YES", "No"])).toBe("bool");
    expect(inferType(["t", "f", "T", "F"])).toBe("bool");
  });

  it("treats 0/1 columns as int, not bool", () => {
    expect(inferType(["0", "1", "0", "1"])).toBe("int");
  });

  it("keeps zero-padded identifiers as text, never int or numeric", () => {
    // The HRSA↔OPAIS case: casting "01234" to a number drops the zeros and breaks the join.
    expect(inferType(["01234", "00567", "09876"])).toBe("text");
    expect(inferType(["1234", "00567", "9876"])).toBe("text");
    expect(inferType(["01.5", "02.25", "03.75"])).toBe("text");
    // A lone "0" (or "-0") is a real number, not padding.
    expect(inferType(["0", "10", "-0", "200"])).toBe("int");
  });

  it("infers date for accepted formats", () => {
    expect(inferType(["2024-01-15", "2024-02-20"])).toBe("date");
    expect(inferType(["2024/01/15", "2024/02/20"])).toBe("date");
    expect(inferType(["01/15/2024", "02/20/2024"])).toBe("date");
  });

  it("infers timestamp — not date — when values carry a time of day", () => {
    expect(inferType(["2024-01-15T10:30:00Z", "2024-02-20T08:00:00+00:00"])).toBe("timestamp");
    expect(inferType(["2024-01-15 10:30:00", "2024-02-20 08:00:00"])).toBe("timestamp");
    expect(inferType(["2024-01-15T10:30", "2024-02-20T08:00"])).toBe("timestamp");
    expect(inferType(["2024-01-15T10:30:00.123Z", "2024-02-20T08:00:00.456Z"])).toBe("timestamp");
  });

  it("ignores textual null tokens when inferring the type", () => {
    // "NULL" among ints must not drag the column to text.
    expect(inferType(["1", "2", "NULL", "3", "n/a"])).toBe("int");
    expect(inferType(["2024-01-15", "#N/A", "2024-02-20"])).toBe("date");
    // An all-null-token column has no evidence at all.
    expect(inferType(["NULL", "N/A", "-", "--", "NaN"])).toBe("text");
  });

  it("falls back to text when fewer than 95% of values match", () => {
    const values = Array.from({ length: 100 }, (_, index) => (index < 94 ? "1" : "maybe"));
    expect(inferType(values)).toBe("text");
  });

  it("returns text for all-empty columns", () => {
    expect(inferType(["", "", ""])).toBe("text");
  });
});

describe("collectSamples", () => {
  it("keeps distinct samples in first-seen order, capped at 5", () => {
    expect(collectSamples(["a", "b", "a", "c", "d", "e", "f", "g"])).toEqual([
      "a",
      "b",
      "c",
      "d",
      "e",
    ]);
  });

  it("preserves leading zeros and grant codes verbatim", () => {
    expect(collectSamples(["00123", "00123", "H80CS00123"])).toEqual(["00123", "H80CS00123"]);
  });

  it("excludes empty cells", () => {
    expect(collectSamples(["", "alpha", "", "beta"])).toEqual(["alpha", "beta"]);
  });

  it("excludes textual null tokens (NULL, N/A, #N/A, NaN, dashes)", () => {
    expect(collectSamples(["NULL", "alpha", "N/A", "#N/A", "beta", "NaN", "-", "--"])).toEqual([
      "alpha",
      "beta",
    ]);
  });
});

describe("sampleScanRows", () => {
  it("returns the rows unchanged when they fit the limit", () => {
    const rows = ["a", "b", "c"];
    expect(sampleScanRows(rows, 5)).toBe(rows);
  });

  it("samples evenly across the file, preserving order, deterministically", () => {
    const rows = Array.from({ length: 100 }, (_, index) => index);
    const sampled = sampleScanRows(rows, 10);

    // Every region of the file is represented, not just the head.
    expect(sampled).toEqual([0, 10, 20, 30, 40, 50, 60, 70, 80, 90]);
    expect(sampleScanRows(rows, 10)).toEqual(sampled);
  });

  it("de-biases a file sorted by the sampled column", () => {
    // 3000 rows sorted by status: a head slice of 1000 would see only "alpha".
    const rows = Array.from({ length: 3000 }, (_, index) =>
      index < 1000 ? "alpha" : index < 2000 ? "beta" : "gamma",
    );

    expect(new Set(sampleScanRows(rows))).toEqual(new Set(["alpha", "beta", "gamma"]));
  });
});

describe("scan-window sampling through parseCsv", () => {
  it("captures values from the whole file, not just the first 1000 rows", () => {
    const statuses = Array.from({ length: 2400 }, (_, index) =>
      index < 800 ? "alpha" : index < 1600 ? "beta" : "gamma",
    );
    const input = ["id,status", ...statuses.map((status, index) => `${index},${status}`)].join(
      "\n",
    );

    const source = parseCsv(input, "sorted.csv");
    const status = source.fields.find((field) => field.name === "status");

    expect(source.rowCount).toBe(2400);
    // The scan window is still bounded…
    expect(status?.stats?.nonEmpty).toBe(MAX_SCAN_ROWS);
    // …but now sees every region of the sorted file.
    expect(status?.stats?.distinct).toBe(3);
    expect(status?.distinctValues).toEqual(["alpha", "beta", "gamma"]);
  });
});

describe("sampleRows retention", () => {
  it("captures field-aligned row tuples from CSV, capped at 200", () => {
    const small = parseCsv("a,b\n1,x\n2,y", "small.csv");
    expect(small.sampleRows).toEqual([
      ["1", "x"],
      ["2", "y"],
    ]);

    const bigInput = [
      "id,status",
      ...Array.from({ length: 2400 }, (_, i) => `${i},s${i % 3}`),
    ].join("\n");
    const big = parseCsv(bigInput, "big.csv");
    expect(big.sampleRows).toHaveLength(200);
    // Tuples stay aligned: each row's id and status came from the same source line.
    for (const row of big.sampleRows ?? []) {
      expect(`s${Number(row[0]) % 3}`).toBe(row[1]);
    }
  });

  it("captures row tuples from JSON records", () => {
    const source = parseJson('[{"a":1,"b":"x"},{"a":2,"b":"y"}]', "r.json");
    expect(source.sampleRows).toEqual([
      ["1", "x"],
      ["2", "y"],
    ]);
  });

  it("captures tuples for a single-sheet workbook but not multi-sheet", () => {
    const single = parseSource({
      name: "single.xlsx",
      kind: "xlsx",
      content: workbookBufferFor({
        Only: [
          ["id", "name"],
          ["1", "Ada"],
        ],
      }),
    });
    expect(single.sampleRows).toEqual([["1", "Ada"]]);

    const multi = parseSource({
      name: "multi.xlsx",
      kind: "xlsx",
      content: workbookBufferFor({
        People: [["id"], ["1"]],
        Places: [["city"], ["Paris"]],
      }),
    });
    // Columns come from different sheets — no single row matrix exists.
    expect(multi.sampleRows).toBeUndefined();
  });
});

/** Standalone workbook builder for tests outside the parseXlsx describe block. */
function workbookBufferFor(sheets: Record<string, string[][]>): ArrayBuffer {
  const workbook = XLSX.utils.book_new();
  for (const [sheetName, rows] of Object.entries(sheets)) {
    XLSX.utils.book_append_sheet(workbook, XLSX.utils.aoa_to_sheet(rows), sheetName);
  }
  return XLSX.write(workbook, { type: "array", bookType: "xlsx" }) as ArrayBuffer;
}

describe("null-token handling in stats", () => {
  it("counts null tokens as blank, disqualifying fake primary keys", () => {
    // Distinct real values, but a third of the column is "N/A" — not PK material.
    const stats = collectStats(["a", "b", "N/A", "c", "NULL", "d"]);

    expect(stats).toEqual({ nonEmpty: 4, distinct: 4, blank: 2 });
  });

  it("recognizes tokens case-insensitively and with padding", () => {
    const stats = collectStats([" null ", "Null", "x", " n/a"]);

    expect(stats).toEqual({ nonEmpty: 1, distinct: 1, blank: 3 });
  });
});

describe("collectStats", () => {
  it("counts non-empty, distinct, and blank values", () => {
    expect(collectStats(["a", "b", "a", "", "c"])).toEqual({ nonEmpty: 4, distinct: 3, blank: 1 });
  });

  it("reports a unique, non-blank column (a PK candidate) as distinct === nonEmpty", () => {
    const stats = collectStats(["1", "2", "3", "4"]);
    expect(stats).toEqual({ nonEmpty: 4, distinct: 4, blank: 0 });
  });

  it("handles an all-empty column", () => {
    expect(collectStats(["", "", ""])).toEqual({ nonEmpty: 0, distinct: 0, blank: 3 });
  });
});

describe("parseCsv", () => {
  const opts = { makeId: makeTestIds("csv") };

  it("preserves header order and reads rows positionally", () => {
    const source = parseCsv("z_col,a_col,m_col\n3,1,2\n", "ordered.csv", opts);

    expect(source.fields.map((field) => field.name)).toEqual(["z_col", "a_col", "m_col"]);
    expect(source.fields[0]?.samples).toEqual(["3"]);
    expect(source.fields[1]?.samples).toEqual(["1"]);
    expect(source.fields[2]?.samples).toEqual(["2"]);
  });

  it("attaches per-field stats distinguishing a unique key from a repeated column", () => {
    const source = parseCsv("id,status\n1,active\n2,active\n3,closed\n", "stats.csv", opts);

    expect(source.fields[0]?.stats).toEqual({ nonEmpty: 3, distinct: 3, blank: 0 });
    expect(source.fields[1]?.stats).toEqual({ nonEmpty: 3, distinct: 2, blank: 0 });
  });

  it("dedupes duplicate headers deterministically", () => {
    const source = parseCsv("name,name,name\na,b,c\n", "dupes.csv", opts);

    expect(source.fields.map((field) => field.name)).toEqual(["name", "name_2", "name_3"]);
    expect(source.fields[0]?.samples).toEqual(["a"]);
    expect(source.fields[1]?.samples).toEqual(["b"]);
    expect(source.fields[2]?.samples).toEqual(["c"]);
  });

  it("infers int and date column types", () => {
    const source = parseCsv("id,started\n42,2024-01-15\n7,2024-02-01\n", "types.csv", opts);

    expect(source.fields[0]?.type).toBe("int");
    expect(source.fields[1]?.type).toBe("date");
  });

  it("uses injected makeId for Source id", () => {
    const source = parseCsv("x\n1\n", "id.csv", { makeId: makeTestIds("csv-id") });
    expect(source.id).toBe("csv-id-1");
  });

  it("counts data rows excluding the header, uncapped past the scan limit", () => {
    const rows = Array.from({ length: 1200 }, (_, i) => String(i + 1)).join("\n");
    const source = parseCsv(`id\n${rows}\n`, "big.csv", opts);
    expect(source.rowCount).toBe(1200);
    // Samples/stats stay capped at the scan limit; rowCount reflects the true total.
    expect(source.fields[0]?.stats?.nonEmpty).toBe(1000);
  });

  it("reports rowCount 0 for empty and header-only files", () => {
    expect(parseCsv("", "empty.csv", opts).rowCount).toBe(0);
    expect(parseCsv("id,name\n", "header-only.csv", opts).rowCount).toBe(0);
  });
});

describe("parseXlsx", () => {
  const opts = { makeId: makeTestIds("xlsx") };

  function workbookBuffer(sheets: Record<string, string[][]>): ArrayBuffer {
    const workbook = XLSX.utils.book_new();
    for (const [sheetName, rows] of Object.entries(sheets)) {
      const sheet = XLSX.utils.aoa_to_sheet(rows);
      XLSX.utils.book_append_sheet(workbook, sheet, sheetName);
    }
    return XLSX.write(workbook, { type: "array", bookType: "xlsx" }) as ArrayBuffer;
  }

  it("prefixes field names when multiple non-empty sheets exist", () => {
    const buffer = workbookBuffer({
      People: [
        ["id", "name"],
        ["1", "Ada"],
      ],
      Places: [
        ["id", "city"],
        ["10", "Paris"],
      ],
      Empty: [
        ["", ""],
        ["", ""],
      ],
    });

    const source = parseXlsx(buffer, "multi.xlsx", opts);
    const names = source.fields.map((field) => field.name);

    expect(names).toEqual(["People.id", "People.name", "Places.id", "Places.city"]);
    expect(source.fields[0]?.samples).toEqual(["1"]);
    expect(source.fields[3]?.samples).toEqual(["Paris"]);
    // Data rows summed across the two non-empty sheets; the empty sheet contributes nothing.
    expect(source.rowCount).toBe(2);
  });

  it("does not prefix field names for a single non-empty sheet", () => {
    const buffer = workbookBuffer({
      Only: [
        ["id", "name"],
        ["1", "Ada"],
      ],
      Empty: [],
    });

    const source = parseXlsx(buffer, "single.xlsx", opts);

    expect(source.fields.map((field) => field.name)).toEqual(["id", "name"]);
    expect(source.rowCount).toBe(1);
  });

  it("uses injected makeId for Source id", () => {
    const buffer = workbookBuffer({ Sheet1: [["a"], ["1"]] });
    const source = parseXlsx(buffer, "id.xlsx", { makeId: makeTestIds("xlsx-id") });
    expect(source.id).toBe("xlsx-id-1");
  });
});

describe("parseJson", () => {
  const opts = { makeId: makeTestIds("json") };

  it("unions keys across array records in first-seen order", () => {
    const source = parseJson('[{"b":2,"a":1},{"c":3,"a":9}]', "array.json", opts);

    expect(source.fields.map((field) => field.name)).toEqual(["b", "a", "c"]);
    expect(source.rowCount).toBe(2);
  });

  it("flattens nested objects to depth 2", () => {
    const source = parseJson(
      '{"name":"Ada","address":{"city":"Paris","geo":{"lat":1}}}',
      "nested.json",
      opts,
    );

    const byName = Object.fromEntries(source.fields.map((field) => [field.name, field]));
    expect(byName.name?.samples).toEqual(["Ada"]);
    expect(byName["address.city"]?.samples).toEqual(["Paris"]);
    expect(byName["address.geo"]?.samples).toEqual(['{"lat":1}']);
  });

  it("stores array values as a single stringified field", () => {
    const source = parseJson('{"tags":["a","b"]}', "arrays.json", opts);
    expect(source.fields[0]).toEqual({
      name: "tags",
      type: "text",
      samples: ['["a","b"]'],
      stats: { nonEmpty: 1, distinct: 1, blank: 0 },
      distinctValues: ['["a","b"]'],
    });
  });

  it("wraps a single top-level object as one record", () => {
    const source = parseJson('{"id":1,"name":"Ada"}', "object.json", opts);
    expect(source.fields).toHaveLength(2);
    expect(source.fields[0]?.samples).toEqual(["1"]);
    expect(source.rowCount).toBe(1);
  });

  it("unwraps records from a top-level envelope object", () => {
    const source = parseJson(
      '{"data":[{"id":1,"name":"Ada"},{"id":2,"name":"Bob"}]}',
      "envelope.json",
      opts,
    );

    expect(source.fields.map((field) => field.name)).toEqual(["id", "name"]);
    expect(source.fields[0]?.samples).toEqual(["1", "2"]);
    // rowCount reflects the unwrapped records, not the envelope object.
    expect(source.rowCount).toBe(2);
  });

  it("unwraps the largest record array and ignores envelope metadata", () => {
    const source = parseJson(
      '{"count":2,"results":[{"sku":"A1","qty":3},{"sku":"B2","qty":7}]}',
      "results.json",
      opts,
    );

    expect(source.fields.map((field) => field.name)).toEqual(["sku", "qty"]);
  });

  it("does not unwrap arrays of scalars", () => {
    const source = parseJson('{"name":"cfg","tags":["a","b"]}', "scalars.json", opts);

    expect(source.fields.map((field) => field.name)).toEqual(["name", "tags"]);
    expect(source.fields[1]?.samples).toEqual(['["a","b"]']);
  });

  it("throws ParseError for malformed JSON", () => {
    expect(() => parseJson("{not json", "bad.json", opts)).toThrow(ParseError);
  });

  it("uses injected makeId for Source id", () => {
    const source = parseJson("{}", "id.json", { makeId: makeTestIds("json-id") });
    expect(source.id).toBe("json-id-1");
  });
});

describe("parseSource", () => {
  it("dispatches by kind", () => {
    const csv = parseSource({
      name: "a.csv",
      kind: "csv",
      content: "x\n1\n",
    });
    expect(csv.kind).toBe("csv");

    const json = parseSource({
      name: "a.json",
      kind: "json",
      content: "{}",
    });
    expect(json.kind).toBe("json");
  });
});
