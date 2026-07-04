import type {
  AiProvider,
  AiProviderResult,
  ConversationTurn,
  ModelInfo,
  ParsedSource,
  Schema,
  SuggestionDigest,
  SuggestionRanking,
  TargetId,
} from "@schema-studio/core";

import { buildCopilotSystemPrompt, buildRerankSystemPrompt } from "../copilot/systemPrompt.js";
import { COPILOT_RESPONSE_TOOL, parseResponseArgs } from "../copilot/responseTool.js";
import { parseCopilotResponse } from "../copilot/parseResponse.js";
import { PREVIEW_EXPORT_TOOL, runExportPreview } from "../copilot/exportPreviewTool.js";
import { INSPECT_SOURCE_TOOL, runInspectSource } from "../copilot/inspectSourceTool.js";
import { parseRankingResponse } from "../suggest/rerank.js";

/** Cap on preview/inspect round-trips within a single propose() before we force a finalization. */
const MAX_PREVIEW_ITERATIONS = 3;

/** A JSON Schema tool spec in the shared `{ name, description, input_schema }` shape. */
type ToolSpec = { name: string; description: string; input_schema: unknown };

type OpenAiToolCall = {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
};

type OpenAiResponseMessage = {
  role: "assistant";
  content: string | null;
  tool_calls?: OpenAiToolCall[];
};

type OpenAiMessage =
  | { role: "system" | "user"; content: string }
  | OpenAiResponseMessage
  | { role: "tool"; tool_call_id: string; content: string };

type OpenAiToolChoice = "required" | "auto" | { type: "function"; function: { name: string } };

type OpenAiChatResponse = {
  choices?: Array<{ message?: OpenAiResponseMessage }>;
};

/**
 * The provider-specific knobs the OpenAI-compatible wire loop needs. Everything that differs
 * between the hosted OpenAI API and a local runtime (URLs, auth, token cap, deadlines, how the
 * model list is parsed, how a transport failure is explained) is injected here; the loop itself is
 * shared.
 */
export type OpenAiCompatibleConfig = {
  /** Human label for this provider, prefixed onto thrown errors so failures are attributable. */
  errorLabel: string;
  /** Chat Completions endpoint, e.g. `https://api.openai.com/v1/chat/completions`. */
  chatUrl: string;
  /** Models list endpoint, e.g. `https://api.openai.com/v1/models`. */
  modelsUrl: string;
  /** The model id sent on every request. */
  model: string;
  /** Upper bound on tokens per completion (covers hidden reasoning tokens too). */
  maxCompletionTokens: number;
  /** Deadline for a generation request; local runtimes are slow, so this is tunable. */
  messageTimeoutMs: number;
  /** Deadline for the (cheap) models-list request. */
  modelsTimeoutMs: number;
  /** Extra headers for auth. Empty for a keyless local endpoint. */
  authHeaders: () => Record<string, string>;
  /** Parse the provider's `GET /models` body into `ModelInfo`s. */
  parseModels: (json: unknown) => ModelInfo[];
  /**
   * Optional: turn a thrown transport error (e.g. a browser `TypeError: Failed to fetch`) into a
   * user-actionable message. Returning a string replaces the raw error; returning undefined keeps
   * it. Used by the local provider to explain a down server or a CORS block.
   */
  describeTransportError?: (error: unknown) => string | undefined;
};

/** Wrap a shared JSON-Schema tool spec in OpenAI's Chat Completions `function` tool shape. */
export function toOpenAiTool(tool: ToolSpec) {
  return {
    type: "function" as const,
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.input_schema,
    },
  };
}

/** Parse a tool call's JSON-string arguments into an object, or report why it couldn't be read. */
function parseToolArguments(raw: string): { value: Record<string, unknown> } | { error: string } {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { error: "Tool call arguments were not valid JSON." };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { error: "Tool call arguments were not a JSON object." };
  }
  return { value: parsed as Record<string, unknown> };
}

/** Like {@link parseToolArguments} but falls back to `{}` so a pure runner can report the error. */
function toolArgsOrEmpty(raw: string): Record<string, unknown> {
  const parsed = parseToolArguments(raw);
  return "value" in parsed ? parsed.value : {};
}

/**
 * The OpenAI Chat Completions implementation of {@link AiProvider}, shared by the hosted OpenAI
 * provider and the local-runtime provider (which speak the same wire format at different URLs).
 * Reuses the same system prompt, tool schemas, and pure tool runners as the Anthropic provider —
 * only the request/response envelope differs. All auth, endpoints, and error phrasing come from the
 * injected {@link OpenAiCompatibleConfig}, so a subclass is just a config.
 */
export class OpenAiCompatibleProvider implements AiProvider {
  constructor(
    protected readonly config: OpenAiCompatibleConfig,
    protected readonly target: TargetId,
  ) {}

  async propose(
    schema: Schema,
    sources: ParsedSource[],
    message: string,
    history: ConversationTurn[] = [],
  ): Promise<AiProviderResult> {
    // OpenAI has no cache-control blocks, so the static + dynamic halves collapse into one system
    // message (automatic prompt caching still applies to the stable prefix, no extra work).
    const system = buildCopilotSystemPrompt(schema, sources, this.target);
    const tools = [PREVIEW_EXPORT_TOOL, INSPECT_SOURCE_TOOL, COPILOT_RESPONSE_TOOL].map(
      toOpenAiTool,
    );
    let messages: OpenAiMessage[] = [
      ...history.map((turn) => ({ role: turn.role, content: turn.content })),
      { role: "user", content: message },
    ];

    // Agentic tool loop: the model may call preview_export or inspect_source (both read-only,
    // in-memory) then finalize with submit_schema_response. `tool_choice: "required"` forces a
    // tool call every step so the loop never dead-ends on a stray sentence.
    for (let iteration = 0; iteration < MAX_PREVIEW_ITERATIONS; iteration += 1) {
      const data = await this.request(system, messages, tools, "required");
      const msg = data.choices?.[0]?.message;
      const toolCalls = msg?.tool_calls ?? [];

      if (toolCalls.some((call) => call.function.name === COPILOT_RESPONSE_TOOL.name)) {
        return this.finalizeMessage(msg);
      }
      if (!msg || toolCalls.length === 0) {
        // No tool call — parse whatever came back (text fallback) or surface it as blocked.
        return this.finalizeMessage(msg);
      }

      // Answer EVERY tool call (OpenAI requires a tool message per tool_call id), then continue.
      const toolResults: OpenAiMessage[] = toolCalls.map((call) => ({
        role: "tool" as const,
        tool_call_id: call.id,
        content: this.runTool(schema, sources, call),
      }));
      messages = [...messages, msg, ...toolResults];
    }

    // Spent the preview budget without finalizing — force one submission so the turn resolves.
    const finalData = await this.request(system, messages, [toOpenAiTool(COPILOT_RESPONSE_TOOL)], {
      type: "function",
      function: { name: COPILOT_RESPONSE_TOOL.name },
    });
    return this.finalizeMessage(finalData.choices?.[0]?.message);
  }

  /** Dispatch one preview/inspect tool call to its pure runner, or report an unknown tool. */
  private runTool(schema: Schema, sources: ParsedSource[], call: OpenAiToolCall): string {
    const args = toolArgsOrEmpty(call.function.arguments);
    if (call.function.name === PREVIEW_EXPORT_TOOL.name) {
      return runExportPreview(schema, args);
    }
    if (call.function.name === INSPECT_SOURCE_TOOL.name) {
      return runInspectSource(sources, args);
    }
    return `error: unknown tool "${call.function.name}".`;
  }

  /** Turn a finalizing response message into a result, surfacing a malformed payload as blocked. */
  private finalizeMessage(msg: OpenAiResponseMessage | undefined): AiProviderResult {
    const finalizeCall = msg?.tool_calls?.find(
      (call) => call.function.name === COPILOT_RESPONSE_TOOL.name,
    );
    if (finalizeCall) {
      const args = parseToolArguments(finalizeCall.function.arguments);
      if ("error" in args) {
        // A malformed payload can't be acted on or revised — surface it and stop the loop.
        return { reply: `(${args.error})`, actions: [], status: "blocked" };
      }
      const parsed = parseResponseArgs(args.value);
      if ("error" in parsed) {
        return { reply: `(${parsed.error})`, actions: [], status: "blocked" };
      }
      return parsed;
    }

    // No forced tool call — fall back to parsing a text reply as JSON (rare) or surface as blocked.
    const text = msg?.content;
    if (typeof text === "string" && text.trim()) {
      const parsed = parseCopilotResponse(text);
      if ("error" in parsed) {
        return { reply: `${text}\n\n(${parsed.error})`.trim(), actions: [], status: "blocked" };
      }
      return parsed;
    }
    return { reply: "The model returned no usable response.", actions: [], status: "blocked" };
  }

  async rankSuggestions(
    schema: Schema,
    sources: ParsedSource[],
    candidates: SuggestionDigest[],
  ): Promise<SuggestionRanking[]> {
    const system = buildRerankSystemPrompt(schema, sources);
    const userMessage = `Rank these suggestions:\n${JSON.stringify({ suggestions: candidates })}`;
    const data = await this.request(system, [{ role: "user", content: userMessage }]);

    const text = data.choices?.[0]?.message?.content ?? "";
    const parsed = parseRankingResponse(text);
    if ("error" in parsed) {
      // Let the caller fall back to the deterministic order rather than act on garbage.
      throw new Error(parsed.error);
    }
    return parsed;
  }

  /**
   * List the chat models this endpoint can serve. The OpenAI-compatible list response comes back in
   * a single body (no pagination cursor). Throws on a non-OK response — or a described transport
   * failure — so callers can fall back to the static catalog.
   */
  async listModels(): Promise<ModelInfo[]> {
    const response = await this.fetchOrDescribe(this.config.modelsUrl, {
      headers: this.headers(),
      signal: AbortSignal.timeout(this.config.modelsTimeoutMs),
    });
    if (!response.ok) {
      const errorBody = await response.text();
      throw new Error(
        `${this.config.errorLabel} Models API error (${response.status}): ${errorBody}`,
      );
    }
    return this.config.parseModels(await response.json());
  }

  /** The shared headers every request needs: JSON content plus whatever auth the config supplies. */
  private headers(): Record<string, string> {
    return { "content-type": "application/json", ...this.config.authHeaders() };
  }

  /**
   * POST a single chat completion. Passing `tools` + `toolChoice` opts into tool-use; omitting
   * them yields a plain text completion (the rerank path).
   */
  private async request(
    system: string,
    messages: OpenAiMessage[],
    tools?: ReturnType<typeof toOpenAiTool>[],
    toolChoice?: OpenAiToolChoice,
  ): Promise<OpenAiChatResponse> {
    const response = await this.fetchOrDescribe(this.config.chatUrl, {
      method: "POST",
      headers: this.headers(),
      signal: AbortSignal.timeout(this.config.messageTimeoutMs),
      body: JSON.stringify({
        model: this.config.model,
        // `max_completion_tokens` is the current param name and is accepted by reasoning models
        // (o-series) that reject the legacy `max_tokens`.
        max_completion_tokens: this.config.maxCompletionTokens,
        messages: [{ role: "system", content: system }, ...messages],
        ...(tools ? { tools } : {}),
        ...(toolChoice ? { tool_choice: toolChoice } : {}),
      }),
    });

    if (!response.ok) {
      const errorBody = await response.text();
      throw new Error(`${this.config.errorLabel} API error (${response.status}): ${errorBody}`);
    }

    return (await response.json()) as OpenAiChatResponse;
  }

  /**
   * `fetch`, but a rejected transport error (down server, DNS failure, CORS block) is routed
   * through the config's {@link OpenAiCompatibleConfig.describeTransportError} so a keyless local
   * endpoint can explain itself instead of leaking a bare `TypeError: Failed to fetch`.
   */
  private async fetchOrDescribe(url: string, init: RequestInit): Promise<Response> {
    try {
      return await fetch(url, init);
    } catch (error) {
      const described = this.config.describeTransportError?.(error);
      throw described ? new Error(described) : error;
    }
  }
}
