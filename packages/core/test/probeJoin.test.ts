import { describe, expect, it } from "vitest";

import type { Schema } from "../src/model.js";
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

  it("keeps full fidelity for a fully-scanned file whose column repeats values", () => {
    // 500 rows, 3 distinct values: the scan window (1000 rows) covered every row, so the
    // figures are exact — fidelity must compare against the window, not the distinct count.
    const repeats = source(
      "r",
      "small.csv",
      [field("state", ["CA", "NY", "TX"])],
      500, // rowCount > distinct count, but under MAX_SCAN_ROWS
    );
    const result = probeJoin([repeats, ...sources], {
      left: { source: "small.csv", field: "state" },
      right: { source: "parent.csv", field: "id" },
    });

    if (!result.ok) {
      throw new Error(result.error);
    }
    expect(result.leftFullFidelity).toBe(true);
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

  it("surfaces the classifier verdict: no_link for the decoy, enforced_fk for the clean FK", () => {
    const decoy = probeJoin(sources, {
      left: { source: "decoy.csv", field: "medicare" },
      right: { source: "parent.csv", field: "id" },
    });
    if (!decoy.ok) {
      throw new Error(decoy.error);
    }
    expect(decoy.verdict).toBe("no_link");

    const fk = probeJoin(sources, {
      left: { source: "child.csv", field: "parent_ref" },
      right: { source: "parent.csv", field: "id" },
    });
    if (!fk.ok) {
      throw new Error(fk.error);
    }
    expect(fk.verdict).toBe("enforced_fk");
  });

  /* PR-6 (GAP F): a probed column already modeled as a PK on the canvas resolves to the "one"
   * side, turning the real run's "N:M at best" into a 1:N nullable FK. */
  it("resolves grain against a canvas PK even when the flat column repeats", () => {
    // Both columns repeat in their flat files (one row per site / per covered entity), so
    // stats-only grain reads N:M.
    const repeatingField = (name: string, values: string[]): SourceField => ({
      name,
      type: "text",
      samples: values.slice(0, 5),
      distinctValues: [...new Set(values)],
      stats: { nonEmpty: values.length, distinct: new Set(values).size, blank: 0 },
    });
    const orgKeys = Array.from({ length: 8 }, (_, i) => `HC${i}`);
    const repeated = orgKeys.flatMap((key) => [key, key, key]);
    const flatSources = [
      source("h", "hrsa.csv", [repeatingField("Health Center Number", repeated)], repeated.length),
      source("o", "opais.json", [repeatingField("grantNumber", repeated.slice(0, 18))], 18),
    ];
    const input = {
      left: { source: "hrsa.csv", field: "Health Center Number" },
      right: { source: "opais.json", field: "grantNumber" },
    };

    const withoutSchema = probeJoin(flatSources, input);
    if (!withoutSchema.ok) {
      throw new Error(withoutSchema.error);
    }
    expect(withoutSchema.grain).toBe("N:M");
    expect(withoutSchema.leftIsEntityKey).toBe(false);

    // The org/site split is on the canvas: organization.health_center_number is a PK. Name
    // matching is loose ("Health Center Number" ↔ health_center_number).
    const schema: Schema = {
      tables: [
        {
          id: "t1",
          name: "organization",
          x: 0,
          y: 0,
          fields: [{ id: "f1", name: "health_center_number", type: "text", pk: true, fk: false }],
        },
      ],
      relationships: [],
    };
    const withSchema = probeJoin(flatSources, input, { schema });
    if (!withSchema.ok) {
      throw new Error(withSchema.error);
    }
    expect(withSchema.leftIsEntityKey).toBe(true);
    expect(withSchema.grain).toBe("1:N");
    expect(withSchema.verdict).toBe("enforced_fk");
  });

  /* A canvas PK is matched to source columns by name, and in the near-universal FK convention
   * the child's FK column carries the parent PK's name (orders.customer_id → customers.customer_id).
   * Raw uniqueness on the parent must outrank the name match, or the child's repeating FK column
   * is promoted to the "one" side and an N:1 reads as 1:1. */
  it("does not promote a child's FK column that shares the parent PK's name", () => {
    const customerIds = Array.from({ length: 20 }, (_, i) => `c${i}`);
    const orderRefs = customerIds.flatMap((id) => [id, id, id]);
    const convention = [
      source(
        "o",
        "orders.csv",
        [
          {
            name: "customer_id",
            type: "text",
            samples: orderRefs.slice(0, 5),
            distinctValues: customerIds,
            stats: { nonEmpty: 60, distinct: 20, blank: 0 },
          },
        ],
        60,
      ),
      source("c", "customers.csv", [field("customer_id", customerIds)], customerIds.length),
    ];
    // The canvas models `customer` with pk `customer_id` — which matches BOTH columns by name.
    const schema: Schema = {
      tables: [
        {
          id: "t1",
          name: "customer",
          x: 0,
          y: 0,
          fields: [{ id: "f1", name: "customer_id", type: "text", pk: true, fk: false }],
        },
      ],
      relationships: [],
    };

    const result = probeJoin(
      convention,
      {
        left: { source: "orders.csv", field: "customer_id" },
        right: { source: "customers.csv", field: "customer_id" },
      },
      { schema },
    );
    if (!result.ok) {
      throw new Error(result.error);
    }

    // Both flagged by name, but customers.customer_id is genuinely unique → it is the parent.
    expect(result.grain).toBe("N:1");
    expect(result.verdict).toBe("enforced_fk");
  });
});
