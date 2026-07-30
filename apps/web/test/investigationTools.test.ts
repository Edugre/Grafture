import type { Schema, Source } from "@grafture/core";
import { describe, expect, it } from "vitest";

import {
  INVESTIGATION_TOOLS,
  isInvestigationTool,
  runInvestigationTool,
} from "../src/copilot/investigationTools.js";
import { PREVIEW_EXPORT_TOOL } from "../src/copilot/exportPreviewTool.js";
import { INSPECT_SOURCE_TOOL } from "../src/copilot/inspectSourceTool.js";
import { PROBE_JOIN_TOOL } from "../src/copilot/probeJoinTool.js";
import { COPILOT_RESPONSE_TOOL } from "../src/copilot/responseTool.js";

const EMPTY_SCHEMA: Schema = { tables: [], relationships: [] };

const sources: Source[] = [
  {
    id: "s",
    name: "sites.csv",
    kind: "csv",
    fields: [
      {
        name: "npi",
        type: "text",
        samples: ["001", "002"],
        distinctValues: ["001", "002"],
        stats: { nonEmpty: 2, distinct: 2, blank: 0 },
      },
    ],
    rowCount: 2,
  },
];

describe("investigation tool registry", () => {
  it("offers exactly the read-only tools, not the finalizing response tool", () => {
    expect(INVESTIGATION_TOOLS.map((tool) => tool.name)).toEqual([
      "preview_export",
      "inspect_source",
      "probe_join",
    ]);
    expect(isInvestigationTool(COPILOT_RESPONSE_TOOL.name)).toBe(false);
  });

  it("recognizes every registered tool", () => {
    for (const tool of INVESTIGATION_TOOLS) {
      expect(isInvestigationTool(tool.name)).toBe(true);
    }
  });

  it("declares every tool in the shared ToolSpec shape", () => {
    // The providers hand these straight to the wire, so a tool missing a description or a
    // schema would be offered to the model as an unusable declaration. `ToolSpec` on the
    // registry makes that a compile error; this asserts the values are actually populated.
    for (const tool of INVESTIGATION_TOOLS) {
      expect(tool.name).toMatch(/^[a-z_]+$/);
      expect(tool.description.length).toBeGreaterThan(0);
      expect(tool.input_schema).toMatchObject({ type: "object" });
    }
  });
});

describe("runInvestigationTool dispatch", () => {
  it("routes each tool to its own runner", () => {
    const preview = runInvestigationTool(PREVIEW_EXPORT_TOOL.name, EMPTY_SCHEMA, sources, {
      target: "sql",
    });
    expect(preview).toContain("Export preview (sql)");

    const inspect = runInvestigationTool(INSPECT_SOURCE_TOOL.name, EMPTY_SCHEMA, sources, {
      source: "sites.csv",
      field: "npi",
    });
    expect(inspect).toContain("sites.csv.npi");

    const probe = runInvestigationTool(PROBE_JOIN_TOOL.name, EMPTY_SCHEMA, sources, {
      left_source: "sites.csv",
      left_field: "npi",
      right_source: "sites.csv",
      right_field: "npi",
    });
    expect(probe).toContain("probe: sites.csv.npi");
  });

  it("reports an unrouted tool instead of returning another tool's output", () => {
    // The regression this guards: dispatch used to fall through to inspect_source by default,
    // so a tool that was offered but never wired returned plausible column stats under its
    // name. An unknown tool must say so.
    const out = runInvestigationTool("profile_column", EMPTY_SCHEMA, sources, {
      source: "sites.csv",
      field: "npi",
    });

    expect(out).toBe('error: unknown tool "profile_column".');
    expect(out).not.toContain("inferred type");
  });

  it("reports an empty tool name rather than dispatching", () => {
    expect(runInvestigationTool("", EMPTY_SCHEMA, sources, {})).toBe('error: unknown tool "".');
  });
});
