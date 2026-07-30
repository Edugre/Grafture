import type { Schema, Source } from "@grafture/core";

import { PREVIEW_EXPORT_TOOL, runExportPreview } from "./exportPreviewTool.js";
import { INSPECT_SOURCE_TOOL, runInspectSource } from "./inspectSourceTool.js";
import { PROBE_JOIN_TOOL, runProbeJoin } from "./probeJoinTool.js";

/**
 * A JSON Schema tool spec in the shared `{ name, description, input_schema }` shape.
 *
 * Both provider families declare tools in this shape, so it lives with the registry rather
 * than being retyped per provider — the same duplication that let the dispatch chains drift.
 */
export type ToolSpec = { name: string; description: string; input_schema: unknown };

/**
 * The read-only tools the copilot may call mid-turn, before finalizing with the response tool.
 *
 * Single source of truth for both providers: they offer this list and dispatch through
 * `runInvestigationTool`, so adding a tool is one edit here rather than a registration and a
 * dispatch arm in each provider — the shape that let a fourth tool be offered but never routed.
 */
export const INVESTIGATION_TOOLS: ToolSpec[] = [
  PREVIEW_EXPORT_TOOL,
  INSPECT_SOURCE_TOOL,
  PROBE_JOIN_TOOL,
];

/** True when `name` is one of the investigation tools (i.e. not the finalizing response tool). */
export function isInvestigationTool(name: string): boolean {
  return INVESTIGATION_TOOLS.some((tool) => tool.name === name);
}

/**
 * Dispatch one investigation tool call to its pure runner. Returns a model-readable string in
 * every case, including an explicit error for an unrecognized name — a tool that was offered but
 * not wired here must say so, never quietly return another tool's output.
 */
export function runInvestigationTool(
  name: string,
  schema: Schema,
  sources: Source[],
  input: unknown,
): string {
  switch (name) {
    case PREVIEW_EXPORT_TOOL.name:
      return runExportPreview(schema, input);
    case INSPECT_SOURCE_TOOL.name:
      return runInspectSource(sources, input);
    case PROBE_JOIN_TOOL.name:
      return runProbeJoin(sources, input, schema);
    default:
      return `error: unknown tool "${name}".`;
  }
}
