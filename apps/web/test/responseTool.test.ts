import { describe, expect, it } from "vitest";

import { COPILOT_RESPONSE_TOOL, parseToolUseResponse } from "../src/copilot/responseTool.js";

function toolBlock(input: unknown) {
  return [{ type: "tool_use", name: COPILOT_RESPONSE_TOOL.name, input }];
}

describe("COPILOT_RESPONSE_TOOL", () => {
  it("declares a forced-callable response envelope", () => {
    expect(COPILOT_RESPONSE_TOOL.name).toBe("submit_schema_response");
    expect(COPILOT_RESPONSE_TOOL.input_schema.required).toEqual(["reply", "status"]);
    expect(COPILOT_RESPONSE_TOOL.input_schema.properties.status.enum).toEqual([
      "complete",
      "needs_revision",
      "blocked",
    ]);
  });
});

describe("parseToolUseResponse", () => {
  it("reads reply, actions, and status from the tool call", () => {
    const result = parseToolUseResponse(
      toolBlock({
        reply: "Linked the tables.",
        actions: [{ op: "add_table", name: "orgs" }],
        status: "complete",
      }),
    );

    expect(result).toEqual({
      reply: "Linked the tables.",
      actions: [{ op: "add_table", name: "orgs" }],
      status: "complete",
    });
  });

  it("defaults missing actions to [] and unknown status to needs_revision", () => {
    const result = parseToolUseResponse(toolBlock({ reply: "Thinking…" }));
    expect(result).toEqual({ reply: "Thinking…", actions: [], status: "needs_revision" });
  });

  it("surfaces a non-array actions payload instead of dropping it", () => {
    const result = parseToolUseResponse(
      toolBlock({ reply: "x", actions: { op: "add_table" }, status: "needs_revision" }),
    );
    expect(result).toEqual({
      error: "Copilot returned 'actions' in an unexpected shape (expected an array).",
    });
  });

  it("errors when the tool arguments are not an object", () => {
    expect(parseToolUseResponse(toolBlock("nope"))).toHaveProperty("error");
  });

  it("falls back to parsing a text block when the model answers in prose", () => {
    const content = [{ type: "text", text: '{"reply":"ok","actions":[],"status":"complete"}' }];
    expect(parseToolUseResponse(content)).toEqual({
      reply: "ok",
      actions: [],
      status: "complete",
    });
  });

  it("errors when there is neither a tool call nor text", () => {
    expect(parseToolUseResponse([{ type: "thinking" }])).toEqual({
      error: "Copilot did not return a structured tool response.",
    });
  });

  it("errors when content is not an array", () => {
    expect(parseToolUseResponse(null)).toEqual({
      error: "Copilot response had no content to read.",
    });
  });
});
