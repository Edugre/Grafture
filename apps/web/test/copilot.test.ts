import { SchemaActionSchema, emptySchema } from "@schema-studio/core";
import { describe, expect, it } from "vitest";

import {
  buildCopilotSystemPrompt,
  formatRejectedAction,
  parseCopilotResponse,
  summarizeAppliedActions,
} from "../src/copilot/index.js";

describe("buildCopilotSystemPrompt", () => {
  it("includes schema, source samples, and the action protocol", () => {
    const prompt = buildCopilotSystemPrompt(emptySchema(), [
      {
        id: "s1",
        name: "covered_entities.csv",
        kind: "csv",
        fields: [{ name: "grant_number", type: "text", samples: ["01234", "05678"] }],
      },
    ]);

    expect(prompt).toContain("grant_number");
    expect(prompt).toContain("01234");
    expect(prompt).toContain("add_relationship");
    // The prompt now instructs a tool call rather than raw JSON output.
    expect(prompt).toContain("submit_schema_response");
    expect(prompt).toContain("sample values");
  });

  it("omits the detector-findings section when there is nothing to report", () => {
    const prompt = buildCopilotSystemPrompt(emptySchema(), [
      {
        id: "s1",
        name: "covered_entities.csv",
        kind: "csv",
        fields: [{ name: "grant_number", type: "text", samples: ["01234", "05678"] }],
      },
    ]);

    expect(prompt).not.toContain("Detector findings");
  });

  it("includes deterministic detector findings when sources overlap", () => {
    const prompt = buildCopilotSystemPrompt(emptySchema(), [
      {
        id: "s1",
        name: "covered_entities.csv",
        kind: "csv",
        fields: [{ name: "grant_number", type: "text", samples: ["01234", "05678", "09999"] }],
      },
      {
        id: "s2",
        name: "organizations.csv",
        kind: "csv",
        fields: [{ name: "grant_id", type: "int", samples: ["1234", "5678", "9999"] }],
      },
    ]);

    expect(prompt).toContain("Detector findings");
    expect(prompt).toContain("covered_entities.csv.grant_number");
    expect(prompt).toContain("strip leading zeros");
  });

  it("frames the prompt for the default Postgres target with its type vocabulary", () => {
    const prompt = buildCopilotSystemPrompt(emptySchema(), []);

    expect(prompt).toContain("Target: PostgreSQL");
    expect(prompt).toContain("integer");
    // A target-specific gotcha that keeps content-aware joins honest.
    expect(prompt).toContain("leading zeros");
  });

  it("switches vocabulary and idioms when the target is Prisma", () => {
    const prompt = buildCopilotSystemPrompt(emptySchema(), [], "prisma");

    expect(prompt).toContain("Target: Prisma");
    expect(prompt).toContain("@id");
    expect(prompt).not.toContain("Target: PostgreSQL");
  });

  it("documents every core action op so the copilot can emit all of them", () => {
    const prompt = buildCopilotSystemPrompt(emptySchema(), []);
    // Guards against protocol drift: if a new op is added to core's union, this fails until
    // it's documented in the prompt (the reason the copilot couldn't emit set_pk/set_cardinality).
    const ops = SchemaActionSchema.options.map((option) => option.shape.op.value);

    expect(ops).toContain("set_cardinality");
    for (const op of ops) {
      expect(prompt).toContain(op);
    }
  });
});

describe("parseCopilotResponse", () => {
  it("parses a bare JSON object", () => {
    const result = parseCopilotResponse(
      '{"reply":"Linked tables.","actions":[{"op":"add_table","name":"orgs"}]}',
    );

    expect(result).toEqual({
      reply: "Linked tables.",
      actions: [{ op: "add_table", name: "orgs" }],
      status: "needs_revision",
    });
  });

  it("parses JSON wrapped in markdown fences", () => {
    const result = parseCopilotResponse('```json\n{"reply":"ok","actions":[]}\n```');

    expect(result).toEqual({ reply: "ok", actions: [], status: "needs_revision" });
  });

  it("parses an explicit status", () => {
    const result = parseCopilotResponse('{"reply":"Done.","actions":[],"status":"complete"}');
    expect(result).toMatchObject({ status: "complete" });
  });

  it("defaults an unknown status to needs_revision", () => {
    const result = parseCopilotResponse('{"reply":"x","actions":[],"status":"whatever"}');
    expect(result).toMatchObject({ status: "needs_revision" });
  });

  it("returns an error for invalid JSON", () => {
    const result = parseCopilotResponse("not json at all");

    expect(result).toEqual({ error: "Copilot response was not valid JSON." });
  });
});

describe("formatRejectedAction", () => {
  it("describes the action and reason", () => {
    const text = formatRejectedAction(
      { op: "add_field", table: "users", name: "email" },
      "field 'email' already exists",
    );

    expect(text).toBe("Couldn't apply add field \"email\" to users: field 'email' already exists");
  });
});

describe("summarizeAppliedActions", () => {
  it("lists ops with table names", () => {
    const schema = emptySchema();
    schema.tables.push({
      id: "t1",
      name: "users",
      x: 0,
      y: 0,
      fields: [],
    });

    const lines = summarizeAppliedActions(schema, [{ op: "add_table", tableIds: ["t1"] }]);

    expect(lines).toEqual(["add_table (users)"]);
  });
});
