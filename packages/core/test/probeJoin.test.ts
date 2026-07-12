import { describe, expect, it } from "vitest";

import type { Source, SourceField } from "../src/parse/types.js";
import { probeJoin } from "../src/detect/index.js";

function field(name: string, values: string[], extra?: Partial<SourceField>): SourceField {
  return {
    name,
    type: "text",
    samples: values.slice(0, 5),
    distinctValues: values,
    stats: {
      nonEmpty: values.length,
      distinct: new Set(values).size,
      blank: 0,
    },
    ...extra,
  };
}

function source(id: string, name: string, fields: SourceField[], rowCount?: number): Source {
  return {
    id,
    name,
    kind: "csv",
    fields,
    ...(rowCount !== undefined ? { rowCount } : {}),
  };
}

/** PR-3 (GAP C): the on-demand join probe — live evidence for a hypothesized pair, no gate. */
describe("probeJoin", () => {
  const parentIds = Array.from({ length: 100 }, (_, i) => `${i + 1}`);
  const childRefs = ["001", "002", "003", ...Array.from({ length: 17 }, (_, i) => `00${i + 4}`)];

  const sources = [
    source("c", "child.csv", [field("parent_ref", childRefs)], childRefs.length),
    source("p", "parent.csv", [field("id", parentIds)], parentIds.length),
    source("x", "decoy.csv", [field("medicare", ["ZZZ1", "ZZZ2", "ZZZ3"])], 3),
  ];

  it("computes live containment/overlap with normalization for the hypothesized pair", () => {
    const result = probeJoin(sources, {
      left: { source: "child.csv", field: "parent_ref" },
      right: { source: "parent.csv", field: "id" },
    });

    if (!result.ok) {
      throw new Error(result.error);
    }
    // "001".."020" ⊆ "1".."100" only after leading-zero stripping.
    expect(result.shared).toBe(20);
    expect(result.containmentLeft).toBe(1);
    expect(result.containmentRight).toBeCloseTo(0.2);
    expect(result.rawOverlap).toBe(0);
    expect(result.formatMismatch?.issues).toContain("leading_zeros");
    expect(result.leftFullFidelity).toBe(true);
  });

  it("reports near-zero evidence for a look-alike decoy (no admission gate)", () => {
    const result = probeJoin(sources, {
      left: { source: "decoy.csv", field: "medicare" },
      right: { source: "parent.csv", field: "id" },
    });

    if (!result.ok) {
      throw new Error(result.error);
    }
    expect(result.shared).toBe(0);
    expect(result.containmentLeft).toBe(0);
  });

  it("names the valid sources/fields on a miss so the model can self-correct", () => {
    const badSource = probeJoin(sources, {
      left: { source: "nope.csv", field: "x" },
      right: { source: "parent.csv", field: "id" },
    });
    expect(badSource.ok).toBe(false);
    if (!badSource.ok) {
      expect(badSource.error).toContain("child.csv");
    }

    const badField = probeJoin(sources, {
      left: { source: "child.csv", field: "nope" },
      right: { source: "parent.csv", field: "id" },
    });
    expect(badField.ok).toBe(false);
    if (!badField.ok) {
      expect(badField.error).toContain("parent_ref");
    }
  });

  it("flags degraded fidelity when a wide set is missing for a large file", () => {
    const bigWithoutWide = source(
      "b",
      "big.csv",
      [field("id", parentIds)],
      50_000, // far more rows than the capped 100-value window
    );
    const result = probeJoin([bigWithoutWide, ...sources], {
      left: { source: "big.csv", field: "id" },
      right: { source: "parent.csv", field: "id" },
    });

    if (!result.ok) {
      throw new Error(result.error);
    }
    expect(result.leftFullFidelity).toBe(false);
    expect(result.rightFullFidelity).toBe(true);
  });
});
