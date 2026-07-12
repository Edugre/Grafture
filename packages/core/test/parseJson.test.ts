import { describe, expect, it } from "vitest";

import { parseJson } from "../src/index.js";

function makeTestIds(prefix: string): () => string {
  let counter = 0;
  return () => `${prefix}-${(counter += 1)}`;
}

/**
 * PR-1 (GAP A): arrays of objects are repeating sub-entities. Each becomes a child `Source`
 * with real leaf columns — not one opaque JSON-string blob — plus a synthetic surrogate pair
 * (`_rowId`/`_parentId`) carrying the structural child→parent link via `derivedFrom` lineage.
 */
describe("parseJson child-source unnesting", () => {
  const opts = () => ({ makeId: makeTestIds("src") });

  const input = JSON.stringify([
    {
      grantNumber: "H80CS001",
      name: "Center A",
      npiNumbers: [
        { npiNumber: "1111111111", state: "MA" },
        { npiNumber: "2222222222", state: "MA" },
      ],
    },
    {
      grantNumber: "H80CS002",
      name: "Center B",
      npiNumbers: [{ npiNumber: "3333333333", state: "NY" }],
    },
  ]);

  it("emits one child source per array-of-objects field, parent first", () => {
    const sources = parseJson(input, "opais.json", opts());

    expect(sources).toHaveLength(2);
    const [parent, child] = sources;
    expect(parent?.name).toBe("opais.json");
    expect(child?.name).toBe("opais.json.npiNumbers");
    expect(child?.kind).toBe("json");
    expect(child?.derivedFrom).toEqual({ parentId: parent?.id, arrayField: "npiNumbers" });
  });

  it("gives the child the array elements' leaf keys plus a synthetic _parentId", () => {
    const [, child] = parseJson(input, "opais.json", opts());

    expect(child?.fields.map((field) => field.name)).toEqual(["npiNumber", "state", "_parentId"]);
    const parentIdField = child?.fields[2];
    expect(parentIdField?.synthetic).toBe(true);
    // Two elements from record 0, one from record 1 — grain N:1 by construction.
    expect(parentIdField?.samples).toEqual(["0", "1"]);
    expect(child?.rowCount).toBe(3);
    const npiField = child?.fields[0];
    expect(npiField?.synthetic).toBeUndefined();
    expect(npiField?.samples).toEqual(["1111111111", "2222222222", "3333333333"]);
  });

  it("adds a synthetic _rowId to the parent and drops the array blob column", () => {
    const [parent] = parseJson(input, "opais.json", opts());

    expect(parent?.fields.map((field) => field.name)).toEqual(["grantNumber", "name", "_rowId"]);
    const rowId = parent?.fields[2];
    expect(rowId?.synthetic).toBe(true);
    expect(rowId?.samples).toEqual(["0", "1"]);
    // Non-surrogate columns are never marked synthetic.
    expect(parent?.fields[0]?.synthetic).toBeUndefined();
  });

  it("populates child sampleRows aligned with its fields (incl. _parentId)", () => {
    const [, child] = parseJson(input, "opais.json", opts());

    expect(child?.sampleRows).toEqual([
      ["1111111111", "MA", "0"],
      ["2222222222", "MA", "0"],
      ["3333333333", "NY", "1"],
    ]);
  });

  it("keeps arrays of scalars stringified — no child source", () => {
    const sources = parseJson('[{"name":"cfg","tags":["a","b"]}]', "scalars.json", opts());

    expect(sources).toHaveLength(1);
    expect(sources[0]?.fields.map((field) => field.name)).toEqual(["name", "tags"]);
    expect(sources[0]?.fields[1]?.samples).toEqual(['["a","b"]']);
  });

  it("does not inject _rowId when there are no children", () => {
    const [parent] = parseJson('[{"a":1},{"a":2}]', "plain.json", opts());
    expect(parent?.fields.map((field) => field.name)).toEqual(["a"]);
  });

  it("de-collides a real column named like the surrogate", () => {
    const sources = parseJson('[{"_rowId":"keep-me","items":[{"v":1}]}]', "collide.json", opts());
    const names = sources[0]?.fields.map((field) => field.name) ?? [];
    expect(names[0]).toBe("_rowId");
    expect(names[1]).toBe("_rowId_2");
    expect(sources[0]?.fields[0]?.synthetic).toBeUndefined();
    expect(sources[0]?.fields[1]?.synthetic).toBe(true);
  });
});

describe("parseJson child completeness", () => {
  it("counts every child element in rowCount even past the scan window", () => {
    const records = Array.from({ length: 1500 }, (_, i) => ({
      id: `p${i}`,
      kids: [{ k: `k${i}a` }, { k: `k${i}b` }],
    }));
    const sources = parseJson(JSON.stringify(records), "big.json", {
      makeId: makeTestIds("big"),
    });

    const child = sources[1];
    expect(child?.rowCount).toBe(3000);
    // Wide join pass covers all child leaves even though stats are windowed.
    expect(child?.fields[0]?.joinValues?.length).toBe(3000);
  });
});
