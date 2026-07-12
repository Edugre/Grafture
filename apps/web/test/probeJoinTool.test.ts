import type { Source } from "@grafture/core";
import { describe, expect, it } from "vitest";

import { PROBE_JOIN_TOOL, runProbeJoin } from "../src/copilot/probeJoinTool.js";

const sources: Source[] = [
  {
    id: "c",
    name: "sites.csv",
    kind: "csv",
    fields: [
      {
        name: "npi",
        type: "text",
        samples: ["001", "002"],
        distinctValues: ["001", "002", "003"],
        stats: { nonEmpty: 3, distinct: 3, blank: 0 },
      },
    ],
    rowCount: 3,
  },
  {
    id: "p",
    name: "registry.csv",
    kind: "csv",
    fields: [
      {
        name: "npi_number",
        type: "int",
        samples: ["1", "2"],
        distinctValues: ["1", "2", "3", "4", "5", "6"],
        stats: { nonEmpty: 6, distinct: 6, blank: 0 },
      },
    ],
    rowCount: 6,
  },
];

describe("probe_join tool", () => {
  it("declares the four ref parameters as required", () => {
    expect(PROBE_JOIN_TOOL.input_schema.required).toEqual([
      "left_source",
      "left_field",
      "right_source",
      "right_field",
    ]);
  });

  it("dispatches to core's probeJoin and formats the evidence", () => {
    const out = runProbeJoin(sources, {
      left_source: "sites.csv",
      left_field: "npi",
      right_source: "registry.csv",
      right_field: "npi_number",
    });

    // "001".."003" ⊆ "1".."6" after leading-zero stripping: containment 100% on the left.
    expect(out).toContain("shared values (normalized): 3");
    expect(out).toContain("100% of left values appear on the right");
    expect(out).toContain("strip leading zeros");
  });

  it("returns a self-correction error naming the valid sources", () => {
    const out = runProbeJoin(sources, {
      left_source: "nope.csv",
      left_field: "npi",
      right_source: "registry.csv",
      right_field: "npi_number",
    });

    expect(out).toContain("probe_join error");
    expect(out).toContain("sites.csv");
  });

  it("tolerates malformed input without throwing", () => {
    expect(runProbeJoin(sources, null)).toContain("probe_join error");
    expect(runProbeJoin(sources, { left_source: 42 })).toContain("probe_join error");
  });
});
