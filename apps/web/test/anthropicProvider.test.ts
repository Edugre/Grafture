import type { Schema } from "@grafture/core";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AnthropicBrowserProvider } from "../src/ai/AnthropicBrowserProvider.js";
import { COPILOT_RESPONSE_TOOL } from "../src/copilot/responseTool.js";
import { PROBE_JOIN_TOOL } from "../src/copilot/probeJoinTool.js";

const EMPTY_SCHEMA: Schema = { tables: [], relationships: [] };

/** Build a fake Anthropic `Response` carrying the given content blocks. */
function okResponse(content: unknown[]) {
  return {
    ok: true,
    json: async () => ({ content }),
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

const npiSource = {
  id: "s1",
  name: "sites.csv",
  kind: "csv" as const,
  fields: [{ name: "npi", type: "text" as const, samples: ["1", "2"] }],
};

const toolNames = (body: Record<string, unknown> | undefined): string[] =>
  ((body?.["tools"] as Array<{ name: string }>) ?? []).map((tool) => tool.name);

const probeCall = () =>
  okResponse([
    {
      type: "tool_use",
      id: "toolu_probe",
      name: PROBE_JOIN_TOOL.name,
      input: {
        left_source: "sites.csv",
        left_field: "npi",
        right_source: "sites.csv",
        right_field: "npi",
      },
    },
  ]);

const submitCall = () =>
  okResponse([
    {
      type: "tool_use",
      id: "toolu_submit",
      name: COPILOT_RESPONSE_TOOL.name,
      input: { reply: "Done.", actions: [], status: "complete" },
    },
  ]);

/* PR-3/PR-4 at the Anthropic loop site: probe_join registered; submit withheld while
 * investigating a fresh derivation, offered from round one otherwise. */
describe("AnthropicBrowserProvider investigation phase", () => {
  it("withholds submit_schema_response for the first two rounds of a fresh derivation", async () => {
    const { bodies } = stubFetch([probeCall(), probeCall(), submitCall()]);

    const provider = new AnthropicBrowserProvider("sk-ant-test");
    const result = await provider.propose(EMPTY_SCHEMA, [npiSource], "derive the schema");

    expect(toolNames(bodies[0])).not.toContain(COPILOT_RESPONSE_TOOL.name);
    expect(toolNames(bodies[1])).not.toContain(COPILOT_RESPONSE_TOOL.name);
    expect(toolNames(bodies[2])).toContain(COPILOT_RESPONSE_TOOL.name);
    expect(toolNames(bodies[0])).toContain(PROBE_JOIN_TOOL.name);
    expect(result.reply).toBe("Done.");
  });

  it("answers a probe_join call with live join evidence", async () => {
    const { bodies } = stubFetch([probeCall(), submitCall(), submitCall()]);

    const provider = new AnthropicBrowserProvider("sk-ant-test");
    await provider.propose(EMPTY_SCHEMA, [npiSource], "derive the schema");

    const followUp = bodies[1]?.["messages"] as Array<{
      role: string;
      content: Array<{ type: string; content?: string }> | string;
    }>;
    const toolResult = followUp
      .flatMap((message) => (Array.isArray(message.content) ? message.content : []))
      .find((block) => block.type === "tool_result");
    expect(toolResult?.content).toContain("containment");
  });

  it("offers submit from round one on a correction turn (history present)", async () => {
    const { bodies } = stubFetch([submitCall()]);

    const provider = new AnthropicBrowserProvider("sk-ant-test");
    await provider.propose(EMPTY_SCHEMA, [npiSource], "fix the rejected action", [
      { role: "user", content: "derive" },
      { role: "assistant", content: "done" },
    ]);

    expect(toolNames(bodies[0])).toContain(COPILOT_RESPONSE_TOOL.name);
  });

  it("offers submit from round one when there are no sources to investigate", async () => {
    const { bodies } = stubFetch([submitCall()]);

    const provider = new AnthropicBrowserProvider("sk-ant-test");
    await provider.propose(EMPTY_SCHEMA, [], "what does 1:N mean?");

    expect(toolNames(bodies[0])).toContain(COPILOT_RESPONSE_TOOL.name);
  });

  it("forces a finalization once the investigation budget is exhausted", async () => {
    const { fetchMock, bodies } = stubFetch([
      probeCall(),
      probeCall(),
      probeCall(),
      probeCall(),
      probeCall(),
      probeCall(),
      submitCall(),
    ]);

    const provider = new AnthropicBrowserProvider("sk-ant-test");
    const result = await provider.propose(EMPTY_SCHEMA, [npiSource], "loop forever");

    expect(fetchMock).toHaveBeenCalledTimes(7);
    expect(bodies[6]?.["tool_choice"]).toEqual({
      type: "tool",
      name: COPILOT_RESPONSE_TOOL.name,
    });
    expect(result.reply).toBe("Done.");
  });
});
