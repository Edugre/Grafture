import type { Source } from "@schema-studio/core";

/** Cap on values returned per call — enough to judge a column, bounded for the context window. */
const MAX_INSPECT_VALUES = 100;

/**
 * A read-only tool the copilot can call mid-turn to see more of a column than the prompt digest
 * carries (5 samples + counts). It returns the column's stats and up to MAX_INSPECT_VALUES of the
 * distinct values captured at parse time — served from memory, no re-parsing. This lets the model
 * resolve uncertainty ("is this really an enum?", "do these ids share a prefix?") on demand
 * instead of every prompt shipping every value of every column.
 */
export const INSPECT_SOURCE_TOOL = {
  name: "inspect_source",
  description:
    "Inspect a source column in more depth: returns its stats (non-empty, distinct, blank counts) and up to 100 of its distinct values. Use it when the sample values in the prompt are not enough to decide a type, key, or normalization question. Read-only.",
  input_schema: {
    type: "object" as const,
    properties: {
      source: {
        type: "string",
        description: "The source file name exactly as listed in <sources>.",
      },
      field: {
        type: "string",
        description: "The column name within that source.",
      },
    },
    required: ["source", "field"],
  },
} as const;

/**
 * Run an `inspect_source` tool call against the live sources. Pure and read-only. Returns an
 * error string (not a throw) so the tool result can be handed straight back to the model,
 * including the valid names so it can self-correct a typo on the next call.
 */
export function runInspectSource(sources: Source[], input: unknown): string {
  const record =
    typeof input === "object" && input !== null ? (input as Record<string, unknown>) : {};
  const sourceName = typeof record["source"] === "string" ? record["source"] : "";
  const fieldName = typeof record["field"] === "string" ? record["field"] : "";

  const source = sources.find((candidate) => candidate.name === sourceName);
  if (!source) {
    const names = sources.map((candidate) => candidate.name).join(", ");
    return `inspect_source error: no source named "${sourceName}". Available sources: ${names || "(none)"}.`;
  }

  const field = source.fields.find((candidate) => candidate.name === fieldName);
  if (!field) {
    const names = source.fields.map((candidate) => candidate.name).join(", ");
    return `inspect_source error: no field named "${fieldName}" in ${source.name}. Available fields: ${names || "(none)"}.`;
  }

  const values = field.distinctValues ?? field.samples;
  const shown = values.slice(0, MAX_INSPECT_VALUES);
  const lines = [
    `${source.name}.${field.name} — inferred type: ${field.type}`,
    ...(source.rowCount !== undefined ? [`rows in file: ${source.rowCount}`] : []),
    ...(field.stats
      ? [
          `scanned values: ${field.stats.nonEmpty} non-empty, ${field.stats.distinct} distinct, ${field.stats.blank} blank`,
        ]
      : ["(no stats captured for this source)"]),
    "",
    `distinct values (${shown.length}${values.length > shown.length ? ` of ${values.length}` : ""}):`,
    JSON.stringify(shown),
  ];

  return lines.join("\n");
}
