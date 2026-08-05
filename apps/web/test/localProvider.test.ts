import type { Schema } from "@grafture/core";
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

/** A non-OK response carrying an error body. */
function errorResponse(status: number, body: string) {
  return { ok: false, status, headers: new Headers(), text: async () => body } as Response;
}

const JSON_REPLY = JSON.stringify({
  reply: "Made an orders table.",
  actions: [{ op: "add_table", name: "orders" }],
  status: "complete",
});

describe("LocalBrowserProvider JSON fallback (models without tool calling)", () => {
  it("falls back to JSON mode when the runtime rejects tools", async () => {
    const { calls } = stubFetch([
      errorResponse(400, '{"error":"llama2 does not support tools"}'),
      okResponse({ role: "assistant", content: JSON_REPLY }),
    ]);

    const provider = new LocalBrowserProvider("http://localhost:11434/v1", "llama2");
    const result = await provider.propose(EMPTY_SCHEMA, [], "make an orders table");

    expect(result).toEqual({
      reply: "Made an orders table.",
      actions: [{ op: "add_table", name: "orders" }],
      status: "complete",
      // The fallback is otherwise invisible; the notice is how the user learns this turn ran
      // without probe_join/inspect_source. It rides beside the reply, never inside it.
      notice: expect.stringContaining("tool-capable"),
    });
    expect(result.reply).not.toContain("tool-capable");
    // The retry is a plain completion: no tools, no tool_choice, and it carries the JSON directive.
    expect(calls[1]?.body["tools"]).toBeUndefined();
    expect(calls[1]?.body["tool_choice"]).toBeUndefined();
    const messages = calls[1]?.body["messages"] as Array<{ role: string; content: string }>;
    expect(messages[0]?.content).toContain("<output_format>");
  });

  it("falls back to JSON mode when the model answers in prose instead of calling a tool", async () => {
    const { fetchMock } = stubFetch([
      // Tool loop: model ignores tool_choice and replies in prose (no tool_calls).
      okResponse({ role: "assistant", content: "Sure, here's what I'd do…" }),
      // JSON-mode retry returns the structured object.
      okResponse({ role: "assistant", content: JSON_REPLY }),
    ]);

    const provider = new LocalBrowserProvider();
    const result = await provider.propose(EMPTY_SCHEMA, [], "make an orders table");

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.reply).toBe("Made an orders table.");
    expect(result.actions).toEqual([{ op: "add_table", name: "orders" }]);
  });

  it("tolerates markdown-fenced JSON in the fallback reply", async () => {
    stubFetch([
      errorResponse(400, "tool_choice is not supported by this model"),
      okResponse({ role: "assistant", content: "```json\n" + JSON_REPLY + "\n```" }),
    ]);

    const result = await new LocalBrowserProvider().propose(EMPTY_SCHEMA, [], "go");
    expect(result.status).toBe("complete");
    expect(result.actions).toEqual([{ op: "add_table", name: "orders" }]);
  });

  it("raises the fallback notice once per provider, not on every turn", async () => {
    stubFetch([
      errorResponse(400, '{"error":"llama2 does not support tools"}'),
      okResponse({ role: "assistant", content: JSON_REPLY }),
      okResponse({ role: "assistant", content: JSON_REPLY }),
    ]);

    const provider = new LocalBrowserProvider("http://localhost:11434/v1", "llama2");
    const first = await provider.propose(EMPTY_SCHEMA, [], "first");
    const second = await provider.propose(EMPTY_SCHEMA, [], "second");

    // Repeating it every turn would be nagging — the model hasn't changed, and the user has read it.
    expect(first.notice).toBeDefined();
    expect(second.notice).toBeUndefined();
  });

  it("notices a blocked fallback turn too, so an unparseable reply names the likely cause", async () => {
    stubFetch([
      okResponse({ role: "assistant", content: "no tools here" }),
      // A model too weak to call tools is also the one likely to emit prose where JSON was asked for.
      okResponse({ role: "assistant", content: "I would probably add a table, I think." }),
    ]);

    const result = await new LocalBrowserProvider().propose(EMPTY_SCHEMA, [], "make a table");

    expect(result.status).toBe("blocked");
    expect(result.notice).toContain("tool-capable");
  });

  it("does not notice a tool-capable model — the strict loop stays silent", async () => {
    stubFetch([
      okResponse({
        role: "assistant",
        content: null,
        tool_calls: [
          toolCall(COPILOT_RESPONSE_TOOL.name, { reply: "ok", actions: [], status: "complete" }),
        ],
      }),
    ]);

    const result = await new LocalBrowserProvider().propose(EMPTY_SCHEMA, [], "make a table");

    expect(result.notice).toBeUndefined();
  });

  it("latches a hard tool rejection: later turns skip the doomed tool attempt", async () => {
    const { calls } = stubFetch([
      errorResponse(400, '{"error":"llama2 does not support tools"}'),
      okResponse({ role: "assistant", content: JSON_REPLY }),
      okResponse({ role: "assistant", content: JSON_REPLY }),
    ]);

    const provider = new LocalBrowserProvider("http://localhost:11434/v1", "llama2");
    // Turn 1: tool attempt (rejected) → JSON retry. Two requests, first carries tools.
    await provider.propose(EMPTY_SCHEMA, [], "first");
    expect(calls).toHaveLength(2);
    expect(calls[0]?.body["tools"]).toBeDefined();

    // Turn 2: goes straight to JSON mode — a single request, no tools, no second rejection.
    await provider.propose(EMPTY_SCHEMA, [], "second");
    expect(calls).toHaveLength(3);
    expect(calls[2]?.body["tools"]).toBeUndefined();
  });

  it("does NOT latch on a prose (non-tool-call) reply — tools are retried next turn", async () => {
    const { calls } = stubFetch([
      // Turn 1: prose (no tool_calls) → JSON retry.
      okResponse({ role: "assistant", content: "thinking out loud…" }),
      okResponse({ role: "assistant", content: JSON_REPLY }),
      // Turn 2: tools attempted again; this time the model finalizes properly.
      okResponse({
        role: "assistant",
        content: null,
        tool_calls: [
          toolCall(COPILOT_RESPONSE_TOOL.name, { reply: "ok", actions: [], status: "complete" }),
        ],
      }),
    ]);

    const provider = new LocalBrowserProvider();
    await provider.propose(EMPTY_SCHEMA, [], "first");
    await provider.propose(EMPTY_SCHEMA, [], "second");

    // Turn 2's request must still carry tools (a prose reply is not a durable "no tools" signal).
    expect(calls[2]?.body["tools"]).toBeDefined();
  });

  it("surfaces a non-tool error unchanged (no fallback for an unrelated failure)", async () => {
    stubFetch([errorResponse(500, "internal server error")]);
    // Zero backoff: a 500 IS retried (see retry.test.ts), and this test is about the fallback not
    // firing, not about how long the wrapper waits between the two attempts.
    const provider = new LocalBrowserProvider("http://localhost:11434/v1", "", "postgres", {
      message: { baseDelayMs: 0, maxDelayMs: 0 },
    });
    // 500 isn't a tool-support problem, so it propagates instead of retrying in JSON mode.
    await expect(provider.propose(EMPTY_SCHEMA, [], "go")).rejects.toThrow(/500/);
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
