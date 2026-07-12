import { describe, expect, it } from "vitest";

import {
  MAX_JOIN_VALUES,
  MAX_SCAN_ROWS,
  collectJoinValues,
  parseCsv,
  parseJson,
} from "../src/index.js";

/**
 * PR-0 (GAP 0): the 1000-row scan cap bounds display samples and stats, but join *discovery*
 * needs the real value sets — `joinValues` is a second, wider pass capped only by the
 * MAX_JOIN_VALUES memory ceiling.
 */
describe("wide join-discovery pass (joinValues)", () => {
  const bigCsv = (rows: number): string =>
    ["id,status", ...Array.from({ length: rows }, (_, i) => `id_${i},s${i % 3}`)].join("\n");

  it("captures more than 1000 distinct join values from a 30k-row source", () => {
    const source = parseCsv(bigCsv(30_000), "big.csv");
    const idField = source.fields[0];

    expect(idField?.joinValues?.length).toBe(30_000);
    // Display/stat windows stay capped — the wide pass must not widen them.
    expect(idField?.distinctValues?.length).toBeLessThanOrEqual(MAX_SCAN_ROWS);
    expect(idField?.samples.length).toBeLessThanOrEqual(5);
    expect(source.sampleRows?.length).toBeLessThanOrEqual(MAX_SCAN_ROWS);
    expect(idField?.stats?.nonEmpty).toBeLessThanOrEqual(MAX_SCAN_ROWS);
  });

  it("omits joinValues when the scan window already saw every row", () => {
    const source = parseCsv(bigCsv(500), "small.csv");
    expect(source.fields[0]?.joinValues).toBeUndefined();
  });

  it("captures wide join values for JSON scalar columns", () => {
    const records = Array.from({ length: 3000 }, (_, i) => ({ code: `c${i}` }));
    const [source] = parseJson(JSON.stringify(records), "big.json");

    expect(source?.fields[0]?.joinValues?.length).toBe(3000);
    expect(source?.fields[0]?.distinctValues?.length).toBeLessThanOrEqual(MAX_SCAN_ROWS);
  });

  it("collectJoinValues dedupes, skips null tokens, and respects the ceiling", () => {
    expect(collectJoinValues(["a", "b", "a", "", "N/A", "c"])).toEqual(["a", "b", "c"]);
    expect(collectJoinValues(["a", "b", "c", "d"], 2)).toEqual(["a", "b"]);
    expect(MAX_JOIN_VALUES).toBeGreaterThanOrEqual(100_000);
  });
});
