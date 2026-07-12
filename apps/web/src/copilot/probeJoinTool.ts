import type { Source } from "@grafture/core";
import { probeJoin } from "@grafture/core";

/**
 * A read-only tool the copilot can call mid-turn to VERIFY a join hypothesis it formed from
 * names or semantics ("these NPI columns should join once normalized") instead of consuming
 * only the precomputed top-N detector findings. It computes live overlap, directional
 * containment, grain, and normalization needs for exactly the pair the model names — served
 * from the in-memory value sets, no re-parsing, no admission gate (near-zero figures are the
 * point when rejecting a look-alike join).
 */
export const PROBE_JOIN_TOOL = {
  name: "probe_join",
  description:
    "Probe a hypothesized join between two source columns: returns their live shared-value count, Jaccard overlap, directional containment (high one-way containment = FK shape: the contained side is the FK side), inferred grain, and any normalization needed (e.g. strip leading zeros) before they match. Use it to VERIFY a join you suspect from names or semantics, or to REJECT a look-alike join, before emitting relationship actions. Read-only. Figures are computed over the widest value sets captured at upload; if a source was reloaded from a saved project the probe notes reduced fidelity (re-upload the file for full-file figures).",
  input_schema: {
    type: "object" as const,
    properties: {
      left_source: {
        type: "string",
        description: "The left source file name exactly as listed in <sources>.",
      },
      left_field: {
        type: "string",
        description: "The column name within the left source.",
      },
      right_source: {
        type: "string",
        description: "The right source file name exactly as listed in <sources>.",
      },
      right_field: {
        type: "string",
        description: "The column name within the right source.",
      },
    },
    required: ["left_source", "left_field", "right_source", "right_field"],
  },
} as const;

const asPercent = (ratio: number): string => `${Math.round(ratio * 100)}%`;

/**
 * Run a `probe_join` tool call against the live sources. Pure and read-only. Returns an error
 * string (not a throw) so the tool result can be handed straight back to the model, including
 * the valid names so it can self-correct a typo on the next call.
 */
export function runProbeJoin(sources: Source[], input: unknown): string {
  const record =
    typeof input === "object" && input !== null ? (input as Record<string, unknown>) : {};
  const str = (key: string): string => (typeof record[key] === "string" ? record[key] : "");

  const result = probeJoin(sources, {
    left: { source: str("left_source"), field: str("left_field") },
    right: { source: str("right_source"), field: str("right_field") },
  });

  if (!result.ok) {
    return `probe_join error: ${result.error}`;
  }

  const leftLabel = `${str("left_source")}.${str("left_field")}`;
  const rightLabel = `${str("right_source")}.${str("right_field")}`;

  const lines = [
    `probe: ${leftLabel} ↔ ${rightLabel}`,
    `shared values (normalized): ${result.shared}`,
    `distinct values: left ${result.leftDistinct}, right ${result.rightDistinct}`,
    `jaccard overlap: raw ${asPercent(result.rawOverlap)}, normalized ${asPercent(result.normalizedOverlap)}`,
    `containment: ${asPercent(result.containmentLeft)} of left values appear on the right; ${asPercent(result.containmentRight)} of right values appear on the left`,
    `inferred grain: ${result.grain}`,
    result.formatMismatch
      ? `normalization needed before joining: ${result.formatMismatch.note}`
      : "no normalization needed",
    ...(!result.leftFullFidelity || !result.rightFullFidelity
      ? [
          `note: ${[
            ...(!result.leftFullFidelity ? [leftLabel] : []),
            ...(!result.rightFullFidelity ? [rightLabel] : []),
          ].join(
            " and ",
          )} lost the wide upload-time value set (project was reloaded) — figures are lower bounds over a ≤1000-value sample; re-upload the file for full-file figures.`,
        ]
      : []),
  ];

  return lines.join("\n");
}
