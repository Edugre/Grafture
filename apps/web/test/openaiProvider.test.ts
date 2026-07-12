import type { Schema } from "@grafture/core";
import { afterEach, describe, expect, it, vi } from "vitest";

import { OpenAiBrowserProvider, toOpenAiTool } from "../src/ai/OpenAiBrowserProvider.js";
import { COPILOT_RESPONSE_TOOL } from "../src/copilot/responseTool.js";
import { PREVIEW_EXPORT_TOOL } from "../src/copilot/exportPreviewTool.js";

const EMPTY_SCHEMA: Schema = { tables: [], relationships: [] };

/** A single tool call in the OpenAI Chat Completions response shape. */
function toolCall(name: string, args: unknown, id = `call_${name}`) {
  return { id, type: "function", function: { name, arguments: JSON.stringify(args) } };
}

/** Build a fake `Response` carrying one assistant message. */
function okResponse(message: unknown) {
  return {
    ok: true,
    json: async () => ({ choices: [{ message }] }),
  } as Response;
}

/** Stub `fetch` to return the given responses in order, and record each request body. */
function stubFetch(responses: Response[]) {
  const bodies: Array<Record<string, unknown>> = [];
  let i = 0;
  const fetchMock = vi.fn(async (_url: unknown, init?: { body?: string }) => {
    bodies.push(init?.body ? JSON.parse(init.body) : {});
    const response = responses[Math.min(i, responses.length - 1)];
    i += 1;
    return response;
  });
  vi.stubGlobal("fetch", fetchMock);
  return { fetchMock, bodies };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("toOpenAiTool", () => {
  it("wraps a shared JSON-Schema tool in OpenAI's function shape", () => {
    const wrapped = toOpenAiTool(COPILOT_RESPONSE_TOOL);
    expect(wrapped).toEqual({
      type: "function",
      function: {
        name: COPILOT_RESPONSE_TOOL.name,
        description: COPILOT_RESPONSE_TOOL.description,
        parameters: COPILOT_RESPONSE_TOOL.input_schema,
      },
    });
  });
});

describe("OpenAiBrowserProvider.propose", () => {
  it("returns the finalized reply, actions, and status from a submit_schema_response call", async () => {
    stubFetch([
      okResponse({
        role: "assistant",
        content: null,
        tool_calls: [
          toolCall(COPILOT_RESPONSE_TOOL.name, {
            reply: "Done.",
            actions: [{ op: "add_table", name: "customers" }],
            status: "complete",
          }),
        ],
      }),
    ]);

    const provider = new OpenAiBrowserProvider("sk-test");
    const result = await provider.propose(EMPTY_SCHEMA, [], "make a customers table");

    expect(result).toEqual({
      reply: "Done.",
      actions: [{ op: "add_table", name: "customers" }],
      status: "complete",
    });
  });

  it("answers a preview_export tool call, then finalizes from the follow-up", async () => {
    const { fetchMock, bodies } = stubFetch([
      okResponse({
        role: "assistant",
        content: null,
        tool_calls: [toolCall(PREVIEW_EXPORT_TOOL.name, { target: "sql" })],
      }),
      okResponse({
        role: "assistant",
        content: null,
        tool_calls: [
          toolCall(COPILOT_RESPONSE_TOOL.name, {
            reply: "Looks good.",
            actions: [],
            status: "complete",
          }),
        ],
      }),
    ]);

    const provider = new OpenAiBrowserProvider("sk-test");
    const result = await provider.propose(EMPTY_SCHEMA, [], "preview then finish");

    expect(fetchMock).toHaveBeenCalledTimes(2);
    // The second request must carry the tool result (the runner's output) back to the model.
    const secondMessages = bodies[1]?.["messages"] as Array<{ role: string; content: string }>;
    const toolMsg = secondMessages.find((m) => m.role === "tool");
    expect(toolMsg).toBeDefined();
    expect(toolMsg?.content).toContain("Export preview (sql)");
    expect(result.reply).toBe("Looks good.");
    expect(result.status).toBe("complete");
  });

  it("forces a finalization once the preview budget is exhausted", async () => {
    // Six preview calls (the loop budget), then the forced request returns a submission.
    const preview = okResponse({
      role: "assistant",
      content: null,
      tool_calls: [toolCall(PREVIEW_EXPORT_TOOL.name, { target: "dbml" })],
    });
    const { fetchMock, bodies } = stubFetch([
      preview,
      preview,
      preview,
      preview,
      preview,
      preview,
      okResponse({
        role: "assistant",
        content: null,
        tool_calls: [
          toolCall(COPILOT_RESPONSE_TOOL.name, {
            reply: "Forced.",
            actions: [],
            status: "complete",
          }),
        ],
      }),
    ]);

    const provider = new OpenAiBrowserProvider("sk-test");
    const result = await provider.propose(EMPTY_SCHEMA, [], "loop forever");

    expect(fetchMock).toHaveBeenCalledTimes(7);
    // The forced request pins tool_choice to the response tool.
    expect(bodies[6]?.["tool_choice"]).toEqual({
      type: "function",
      function: { name: COPILOT_RESPONSE_TOOL.name },
    });
    expect(result.reply).toBe("Forced.");
  });

  it("surfaces malformed finalize arguments as a blocked turn instead of throwing", async () => {
    stubFetch([
      okResponse({
        role: "assistant",
        content: null,
        tool_calls: [
          {
            id: "call_bad",
            type: "function",
            function: { name: COPILOT_RESPONSE_TOOL.name, arguments: "{not json" },
          },
        ],
      }),
    ]);

    const provider = new OpenAiBrowserProvider("sk-test");
    const result = await provider.propose(EMPTY_SCHEMA, [], "break it");

    expect(result.status).toBe("blocked");
    expect(result.actions).toEqual([]);
  });

  it("falls back to parsing a plain-text reply when the model ignores tool_choice", async () => {
    stubFetch([
      okResponse({
        role: "assistant",
        content: '{"reply":"text path","actions":[],"status":"complete"}',
      }),
    ]);

    const provider = new OpenAiBrowserProvider("sk-test");
    const result = await provider.propose(EMPTY_SCHEMA, [], "no tools");

    expect(result.reply).toBe("text path");
    expect(result.status).toBe("complete");
  });

  it("throws with the response body on a non-OK status", async () => {
    stubFetch([{ ok: false, status: 401, text: async () => "bad key" } as Response]);

    const provider = new OpenAiBrowserProvider("sk-test");
    await expect(provider.propose(EMPTY_SCHEMA, [], "unauthorized")).rejects.toThrow(/401/);
  });
});

/* PR-3/PR-4: the investigation phase. On a fresh derivation with sources, submit is withheld
 * for the first rounds (probe/inspect/preview only), then offered; probe_join is registered. */
describe("OpenAiBrowserProvider investigation phase", () => {
  const npiSource = {
    id: "s1",
    name: "sites.csv",
    kind: "csv" as const,
    fields: [{ name: "npi", type: "text" as const, samples: ["1", "2"] }],
  };

  const toolNames = (body: Record<string, unknown> | undefined): string[] =>
    ((body?.["tools"] as Array<{ function: { name: string } }>) ?? []).map(
      (tool) => tool.function.name,
    );

  const probe = () =>
    okResponse({
      role: "assistant",
      content: null,
      tool_calls: [
        toolCall("probe_join", {
          left_source: "sites.csv",
          left_field: "npi",
          right_source: "sites.csv",
          right_field: "npi",
        }),
      ],
    });
  const submit = () =>
    okResponse({
      role: "assistant",
      content: null,
      tool_calls: [
        toolCall(COPILOT_RESPONSE_TOOL.name, { reply: "Done.", actions: [], status: "complete" }),
      ],
    });

  it("withholds submit_schema_response for the first two rounds of a fresh derivation", async () => {
    const { bodies } = stubFetch([probe(), probe(), submit()]);

    const provider = new OpenAiBrowserProvider("sk-test");
    const result = await provider.propose(EMPTY_SCHEMA, [npiSource], "derive the schema");

    expect(toolNames(bodies[0])).not.toContain(COPILOT_RESPONSE_TOOL.name);
    expect(toolNames(bodies[1])).not.toContain(COPILOT_RESPONSE_TOOL.name);
    expect(toolNames(bodies[2])).toContain(COPILOT_RESPONSE_TOOL.name);
    // The investigation tools are offered throughout, including probe_join.
    expect(toolNames(bodies[0])).toContain("probe_join");
    expect(result.reply).toBe("Done.");
  });

  it("answers a probe_join call with live join evidence", async () => {
    const { bodies } = stubFetch([probe(), probe(), submit()]);

    const provider = new OpenAiBrowserProvider("sk-test");
    await provider.propose(EMPTY_SCHEMA, [npiSource], "derive the schema");

    const followUp = bodies[1]?.["messages"] as Array<{ role: string; content: string }>;
    const toolMsg = followUp.find((message) => message.role === "tool");
    expect(toolMsg?.content).toContain("containment");
  });

  it("offers submit from round one on a correction turn (history present)", async () => {
    const { bodies } = stubFetch([submit()]);

    const provider = new OpenAiBrowserProvider("sk-test");
    await provider.propose(EMPTY_SCHEMA, [npiSource], "fix the rejected action", [
      { role: "user", content: "derive" },
      { role: "assistant", content: "done" },
    ]);

    expect(toolNames(bodies[0])).toContain(COPILOT_RESPONSE_TOOL.name);
  });

  it("offers submit from round one when there are no sources to investigate", async () => {
    const { bodies } = stubFetch([submit()]);

    const provider = new OpenAiBrowserProvider("sk-test");
    await provider.propose(EMPTY_SCHEMA, [], "what does 1:N mean?");

    expect(toolNames(bodies[0])).toContain(COPILOT_RESPONSE_TOOL.name);
  });
});
