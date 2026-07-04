import type { Schema } from "@schema-studio/core";
import { afterEach, describe, expect, it, vi } from "vitest";

import { LocalBrowserProvider } from "../src/ai/LocalBrowserProvider.js";
import { COPILOT_RESPONSE_TOOL } from "../src/copilot/responseTool.js";

const EMPTY_SCHEMA: Schema = { tables: [], relationships: [] };

/** A single tool call in the OpenAI-compatible response shape. */
function toolCall(name: string, args: unknown, id = `call_${name}`) {
  return { id, type: "function", function: { name, arguments: JSON.stringify(args) } };
}

function okResponse(message: unknown) {
  return { ok: true, json: async () => ({ choices: [{ message }] }) } as Response;
}

/** Stub `fetch`, recording each request's URL, headers, and parsed body. */
function stubFetch(responses: Response[]) {
  const calls: Array<{
    url: string;
    headers: Record<string, string>;
    body: Record<string, unknown>;
  }> = [];
  let i = 0;
  const fetchMock = vi.fn(
    async (url: unknown, init?: { headers?: Record<string, string>; body?: string }) => {
      calls.push({
        url: String(url),
        headers: init?.headers ?? {},
        body: init?.body ? JSON.parse(init.body) : {},
      });
      const response = responses[Math.min(i, responses.length - 1)];
      i += 1;
      return response;
    },
  );
  vi.stubGlobal("fetch", fetchMock);
  return { fetchMock, calls };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("LocalBrowserProvider.propose", () => {
  it("finalizes from a submit_schema_response tool call, like the hosted provider", async () => {
    stubFetch([
      okResponse({
        role: "assistant",
        content: null,
        tool_calls: [
          toolCall(COPILOT_RESPONSE_TOOL.name, {
            reply: "Done.",
            actions: [{ op: "add_table", name: "orders" }],
            status: "complete",
          }),
        ],
      }),
    ]);

    const provider = new LocalBrowserProvider();
    const result = await provider.propose(EMPTY_SCHEMA, [], "make an orders table");

    expect(result).toEqual({
      reply: "Done.",
      actions: [{ op: "add_table", name: "orders" }],
      status: "complete",
    });
  });

  it("posts to the endpoint's chat/completions URL and sends NO Authorization header", async () => {
    const { calls } = stubFetch([
      okResponse({
        role: "assistant",
        content: null,
        tool_calls: [
          toolCall(COPILOT_RESPONSE_TOOL.name, { reply: "ok", actions: [], status: "complete" }),
        ],
      }),
    ]);

    const provider = new LocalBrowserProvider("http://localhost:1234/v1", "llama3.1");
    await provider.propose(EMPTY_SCHEMA, [], "hi");

    expect(calls[0]?.url).toBe("http://localhost:1234/v1/chat/completions");
    expect(calls[0]?.body["model"]).toBe("llama3.1");
    // Keyless: content-type only, never an Authorization header.
    const headerKeys = Object.keys(calls[0]?.headers ?? {}).map((k) => k.toLowerCase());
    expect(headerKeys).toContain("content-type");
    expect(headerKeys).not.toContain("authorization");
  });

  it("trims a trailing slash on the endpoint so URLs never double up", async () => {
    const { calls } = stubFetch([
      okResponse({
        role: "assistant",
        content: null,
        tool_calls: [
          toolCall(COPILOT_RESPONSE_TOOL.name, { reply: "ok", actions: [], status: "complete" }),
        ],
      }),
    ]);

    await new LocalBrowserProvider("http://localhost:11434/v1/").propose(EMPTY_SCHEMA, [], "hi");
    expect(calls[0]?.url).toBe("http://localhost:11434/v1/chat/completions");
  });
});

describe("LocalBrowserProvider.listModels", () => {
  it("fetches {endpoint}/models and parses it with no family filtering", async () => {
    const { calls } = stubFetch([
      {
        ok: true,
        json: async () => ({ data: [{ id: "llama3.1:8b" }, { id: "nomic-embed-text" }] }),
      } as Response,
    ]);

    const models = await new LocalBrowserProvider().listModels();

    expect(calls[0]?.url).toBe("http://localhost:11434/v1/models");
    expect(models.map((m) => m.id)).toEqual(["llama3.1:8b", "nomic-embed-text"]);
  });
});

describe("LocalBrowserProvider transport errors", () => {
  it("rewrites a bare fetch TypeError into actionable server/CORS guidance", async () => {
    const fetchMock = vi.fn(async () => {
      throw new TypeError("Failed to fetch");
    });
    vi.stubGlobal("fetch", fetchMock);

    const provider = new LocalBrowserProvider();
    await expect(provider.propose(EMPTY_SCHEMA, [], "hi")).rejects.toThrow(
      /Couldn't reach a local model server.*OLLAMA_ORIGINS/s,
    );
  });

  it("lets a timeout (DOMException) bubble unchanged", async () => {
    const fetchMock = vi.fn(async () => {
      throw new DOMException("The operation was aborted.", "TimeoutError");
    });
    vi.stubGlobal("fetch", fetchMock);

    const provider = new LocalBrowserProvider();
    await expect(provider.propose(EMPTY_SCHEMA, [], "hi")).rejects.toThrow(/aborted/);
  });
});
