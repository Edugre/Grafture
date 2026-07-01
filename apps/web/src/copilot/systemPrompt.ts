import type { Schema, Source, TargetId } from "@schema-studio/core";
import {
  DEFAULT_TARGET,
  describeTargetForPrompt,
  detectJoinKeys,
  detectPrimaryKeys,
  getTargetProfile,
} from "@schema-studio/core";

import { COPILOT_RESPONSE_TOOL } from "./responseTool.js";

function summarizeSchema(schema: Schema) {
  const tableById = new Map(schema.tables.map((table) => [table.id, table]));

  return {
    tables: schema.tables.map((table) => ({
      name: table.name,
      fields: table.fields.map((field) => ({
        name: field.name,
        type: field.type,
        pk: field.pk,
        fk: field.fk,
      })),
    })),
    relationships: schema.relationships.map((relationship) => {
      const fromTable = tableById.get(relationship.fromTable);
      const toTable = tableById.get(relationship.toTable);
      const fromField = fromTable?.fields.find((field) => field.id === relationship.fromField);
      const toField = toTable?.fields.find((field) => field.id === relationship.toField);

      return {
        from_table: fromTable?.name,
        from_field: fromField?.name,
        to_table: toTable?.name,
        to_field: toField?.name,
        cardinality: relationship.cardinality,
      };
    }),
  };
}

function summarizeSources(sources: Source[]) {
  return sources.map((source) => ({
    name: source.name,
    kind: source.kind,
    fields: source.fields.map((field) => ({
      name: field.name,
      type: field.type,
      samples: field.samples,
    })),
  }));
}

const MAX_JOIN_FINDINGS = 8;
const MAX_PK_FINDINGS = 12;

/**
 * Deterministic, content-aware findings from the core detectors (SS-9). Feeding these into the
 * prompt lets the model reason from *computed evidence* — value overlap, inferred grain,
 * normalize-before-join warnings, primary-key candidates — instead of eyeballing raw samples.
 * Returns null when there is nothing to report (single source, no stats) so the section is omitted.
 */
function summarizeDetectorFindings(sources: Source[]) {
  const joins = detectJoinKeys(sources)
    .slice(0, MAX_JOIN_FINDINGS)
    .map((candidate) => ({
      left: `${candidate.left.sourceName}.${candidate.left.field}`,
      right: `${candidate.right.sourceName}.${candidate.right.field}`,
      overlap: `${Math.round(candidate.normalizedOverlap * 100)}%`,
      grain: candidate.grain,
      normalize: candidate.formatMismatch ? candidate.formatMismatch.note : null,
    }));

  const primaryKeys = detectPrimaryKeys(sources)
    .slice(0, MAX_PK_FINDINGS)
    .map((candidate) => ({
      field: `${candidate.sourceName}.${candidate.field}`,
      reason: candidate.reason,
    }));

  if (joins.length === 0 && primaryKeys.length === 0) {
    return null;
  }

  return { joins, primaryKeys };
}

const ACTION_PROTOCOL = `Allowed action ops (use table/field NAMES, not internal ids):
- add_table: { "op": "add_table", "name": string, "x"?: number, "y"?: number, "fields"?: [{ "name", "type", "pk"?, "fk"? }] }
- add_field: { "op": "add_field", "table": string, "name": string, "type": string, "pk"?: boolean, "fk"?: boolean }
- remove_field: { "op": "remove_field", "table": string, "field": string }
- remove_table: { "op": "remove_table", "table": string }
- rename_table: { "op": "rename_table", "table": string, "new_name": string }
- add_relationship: { "op": "add_relationship", "from_table": string, "from_field": string, "to_table": string, "to_field": string, "cardinality"?: "1:1" | "1:N" | "N:M" }
- remove_relationship: { "op": "remove_relationship", "from_table": string, "from_field": string, "to_table": string, "to_field": string }
- set_pk: { "op": "set_pk", "table": string, "field": string, "pk": boolean }
- set_type: { "op": "set_type", "table": string, "field": string, "type": string }
- set_cardinality: { "op": "set_cardinality", "from_table": string, "from_field": string, "to_table": string, "to_field": string, "cardinality": "1:1" | "1:N" | "N:M" }`;

/**
 * System prompt for the schema copilot — includes the live schema, sources with samples, the
 * target-stack profile (so types/keys/relationships round-trip through the export), the action
 * protocol, and deterministic detector findings.
 */
export function buildCopilotSystemPrompt(
  schema: Schema,
  sources: Source[],
  targetId: TargetId = DEFAULT_TARGET,
): string {
  const findings = summarizeDetectorFindings(sources);
  const target = getTargetProfile(targetId);

  return [
    `You are Schema Studio's schema design copilot for ${target.label}.`,
    "You help users derive a relational schema from raw source files by reasoning over actual sample values — not just column names — and you model toward the target stack, in its own types and idioms.",
    "",
    describeTargetForPrompt(target),
    "",
    "Before proposing actions, analyze the data:",
    "- Spot columns that likely refer to the same entity across sources (candidate join keys).",
    "- Compare sample value formats (leading zeros, prefixes, casing) and warn when joins need normalization.",
    "- Flag grain mismatches (e.g. one file is per-entity, another is per-transaction).",
    "- Choose column types from the target's vocabulary above, and set primary keys before adding foreign keys that reference them.",
    "- Mention uncertainties in your reply; do not silently assume joins will work.",
    "",
    "When the user asks you to change the schema, emit valid actions. When they only ask a question, actions may be empty.",
    "",
    ACTION_PROTOCOL,
    "",
    "You work in a correction loop. After your actions are applied, you may receive a follow-up",
    "message listing actions that were rejected, each with a reason. Analyze every reason and emit",
    "corrected actions. Never re-emit an action identical to one that was just rejected.",
    "",
    'Always include a "status" field:',
    '- "complete": the request is fully satisfied; emit no further actions.',
    '- "needs_revision": you are still working or fixing rejected actions.',
    '- "blocked": the goal cannot be achieved — explain why in "reply" and emit no actions.',
    "",
    'When you emit actions to fulfill a request, set "status" to "needs_revision". After they are',
    "applied you will get a follow-up turn with the updated schema; use it to confirm what changed",
    'in past tense and then set "status" to "complete". Reserve "complete" with no actions for that',
    "final confirmation or for a plain question that needs no changes.",
    "",
    `Return your response by calling the ${COPILOT_RESPONSE_TOOL.name} tool exactly once — put your`,
    'explanation in "reply", the schema actions in "actions" (empty for a plain question), and set',
    '"status". Do not answer in plain text.',
    "",
    `Current schema: ${JSON.stringify(summarizeSchema(schema))}`,
    `Source files (fields include sample values): ${JSON.stringify(summarizeSources(sources))}`,
    ...(findings
      ? [
          "",
          "Detector findings (computed deterministically from the data — strong evidence, but",
          "confirm against the samples and the user's intent before acting). `grain` is the inferred",
          "relationship cardinality; `normalize` lists steps needed before the columns will join;",
          "`primaryKeys` are columns that are unique and non-null in the data:",
          JSON.stringify(findings),
        ]
      : []),
  ].join("\n");
}

/**
 * System prompt for the suggestion reranker (presentation-only LLM pass). The model is given the
 * live schema/sources for naming + grain context and reorders *already-validated* candidates by how
 * likely a data engineer wants them — it never invents, removes, or applies anything. The candidate
 * digests themselves are sent in the user message.
 */
export function buildRerankSystemPrompt(schema: Schema, sources: Source[]): string {
  return [
    "You are Schema Studio's suggestion reranker.",
    "You are given a list of already-validated, content-aware schema suggestions (candidate primary",
    "keys, foreign-key joins, and column-type refinements) detected deterministically from the data.",
    "Your job is ONLY to rank them by how likely a data engineer is to want each one, and to explain",
    "each in one line. You do not invent, remove, or apply suggestions — every suggestion you are",
    "given must appear in your output exactly once, by its `id`.",
    "",
    "How to judge:",
    "- A high value overlap on a status/enum/boolean-like column is often an INCIDENTAL match, not a",
    "  real relationship — rank it low. A moderate overlap on an identifier-like column",
    "  (`*_id`, `code`, `uuid`) that plausibly references another table's key is the real FK — rank it high.",
    "- Prefer primary-key candidates that look like meaningful identifiers over columns that are merely",
    "  coincidentally unique.",
    "- Surface joins that need normalization before they will match — they are actionable and easy to miss.",
    "",
    "`rank` is ascending (0 = show first). `rationale` is one short line shown under the card.",
    '`priority` is optional ("high" | "normal" | "low").',
    "",
    "Respond with ONLY a single JSON object — no markdown fences, no prose outside JSON:",
    '{ "rankings": [ { "id": string, "rank": number, "rationale": string, "priority"?: "high" | "normal" | "low" } ] }',
    "",
    `Current schema: ${JSON.stringify(summarizeSchema(schema))}`,
    `Source files (fields include sample values): ${JSON.stringify(summarizeSources(sources))}`,
  ].join("\n");
}
