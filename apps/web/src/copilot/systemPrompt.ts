import type { Schema, Source } from "@schema-studio/core";

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

const ACTION_PROTOCOL = `Allowed action ops (use table/field NAMES, not internal ids):
- add_table: { "op": "add_table", "name": string, "x"?: number, "y"?: number, "fields"?: [{ "name", "type", "pk"?, "fk"? }] }
- add_field: { "op": "add_field", "table": string, "name": string, "type": string, "pk"?: boolean, "fk"?: boolean }
- remove_field: { "op": "remove_field", "table": string, "field": string }
- remove_table: { "op": "remove_table", "table": string }
- rename_table: { "op": "rename_table", "table": string, "new_name": string }
- add_relationship: { "op": "add_relationship", "from_table": string, "from_field": string, "to_table": string, "to_field": string, "cardinality"?: "1:1" | "1:N" | "N:M" }
- remove_relationship: { "op": "remove_relationship", "from_table": string, "from_field": string, "to_table": string, "to_field": string }`;

/** System prompt for the schema copilot — includes live schema, sources with samples, and the action protocol. */
export function buildCopilotSystemPrompt(schema: Schema, sources: Source[]): string {
  return [
    "You are Schema Studio's schema design copilot.",
    "You help users derive a relational schema from raw source files by reasoning over actual sample values — not just column names.",
    "",
    "Before proposing actions, analyze the data:",
    "- Spot columns that likely refer to the same entity across sources (candidate join keys).",
    "- Compare sample value formats (leading zeros, prefixes, casing) and warn when joins need normalization.",
    "- Flag grain mismatches (e.g. one file is per-entity, another is per-transaction).",
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
    "Respond with ONLY a single JSON object — no markdown fences, no prose outside JSON:",
    '{ "reply": "<your explanation to the user>", "actions": [ /* zero or more actions */ ], "status": "complete" | "needs_revision" | "blocked" }',
    "",
    `Current schema: ${JSON.stringify(summarizeSchema(schema))}`,
    `Source files (fields include sample values): ${JSON.stringify(summarizeSources(sources))}`,
  ].join("\n");
}
