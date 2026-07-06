import type { Source } from "@schema-studio/core";
import { describe, expect, it } from "vitest";

import { runInspectSource } from "../src/copilot/inspectSourceTool.js";

const sources: Source[] = [
  {
    id: "s1",
    name: "orders.csv",
    kind: "csv",
    rowCount: 320,
    fields: [
      {
        name: "status",
        type: "text",
        samples: ["shipped", "pending"],
        distinctValues: ["shipped", "pending", "cancelled"],
        stats: {
          nonEmpty: 320,
          distinct: 3,
          blank: 0,
          topValues: [
            { value: "shipped", count: 250 },
            { value: "pending", count: 60 },
          ],
        },
      },
      {
        name: "amount",
        type: "numeric",
        samples: ["10.5", "99.99"],
        stats: { nonEmpty: 320, distinct: 300, blank: 0, min: 0.5, max: 999.99 },
      },
      {
        name: "note",
        type: "text",
        samples: ["a", "b"],
      },
    ],
  },
];

describe("runInspectSource", () => {
  it("returns stats and distinct values for a valid column", () => {
    const result = runInspectSource(sources, { source: "orders.csv", field: "status" });

    expect(result).toContain("orders.csv.status");
    expect(result).toContain("rows in file: 320");
    expect(result).toContain("320 non-empty, 3 distinct, 0 blank");
    expect(result).toContain("cancelled");
    expect(result).toContain('most frequent values: "shipped" \u00d7250, "pending" \u00d760');
  });

  it("reports the numeric range when the stats carry one", () => {
    const result = runInspectSource(sources, { source: "orders.csv", field: "amount" });
    expect(result).toContain("numeric range: 0.5 to 999.99");
  });

  it("falls back to samples and flags missing stats for older sources", () => {
    const result = runInspectSource(sources, { source: "orders.csv", field: "note" });

    expect(result).toContain("(no stats captured for this source)");
    expect(result).toContain('["a","b"]');
  });

  it("names the available sources on a bad source name", () => {
    const result = runInspectSource(sources, { source: "nope.csv", field: "status" });

    expect(result).toContain("inspect_source error");
    expect(result).toContain("orders.csv");
  });

  it("names the available fields on a bad field name", () => {
    const result = runInspectSource(sources, { source: "orders.csv", field: "nope" });

    expect(result).toContain("inspect_source error");
    expect(result).toContain("status");
    expect(result).toContain("note");
  });

  it("handles malformed input without throwing", () => {
    expect(runInspectSource(sources, null)).toContain("inspect_source error");
    expect(runInspectSource(sources, { source: 5 })).toContain("inspect_source error");
  });

  it("caps the returned values at 100 and says how many were omitted", () => {
    const many: Source[] = [
      {
        id: "s2",
        name: "big.csv",
        kind: "csv",
        fields: [
          {
            name: "id",
            type: "int",
            samples: ["1"],
            distinctValues: Array.from({ length: 250 }, (_, index) => String(index)),
          },
        ],
      },
    ];

    const result = runInspectSource(many, { source: "big.csv", field: "id" });

    expect(result).toContain("distinct values (100 of 250)");
    expect(result).not.toContain('"249"');
  });
});
