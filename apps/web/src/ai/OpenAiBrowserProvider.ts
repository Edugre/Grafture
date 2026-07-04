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
import { DEFAULT_TARGET } from "@schema-studio/core";

import { buildCopilotSystemPrompt, buildRerankSystemPrompt } from "../copilot/systemPrompt.js";
import { COPILOT_RESPONSE_TOOL, parseResponseArgs } from "../copilot/responseTool.js";
import { parseCopilotResponse } from "../copilot/parseResponse.js";
import { PREVIEW_EXPORT_TOOL, runExportPreview } from "../copilot/exportPreviewTool.js";
import { INSPECT_SOURCE_TOOL, runInspectSource } from "../copilot/inspectSourceTool.js";
import { parseRankingResponse } from "../suggest/rerank.js";
import { OPENAI_DEFAULT_MODEL, parseOpenAiModels } from "./openaiModels.js";

const OPENAI_API_URL = "https://api.openai.com/v1/chat/completions";
const OPENAI_MODELS_URL = "https://api.openai.com/v1/models";

// Mirror the Anthropic provider's deadlines: generation can legitimately take a while, listing
// models cannot. Without a deadline a stalled connection wedges propose() forever (the agent
// loop's cancel check only runs between rounds).
const MESSAGE_TIMEOUT_MS = 120_000;
const MODELS_TIMEOUT_MS = 15_000;

/** Cap on preview/inspect round-trips within a single propose() before we force a finalization. */
const MAX_PREVIEW_ITERATIONS = 3;

// Upper bound on tokens per completion. Unlike Anthropic's `max_tokens` (visible output only),
// OpenAI's `max_completion_tokens` also has to cover the hidden reasoning tokens the o-series
// spends before answering — a 4k cap can be entirely consumed by reasoning, leaving no output and
// a `length` finish. This is a ceiling, not a reservation (billing is per token produced), so a
// generous value is safe for non-reasoning models like gpt-4.1 too.
const MAX_COMPLETION_TOKENS = 32_768;

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
 * OpenAI Chat Completions implementation of {@link AiProvider}. A sibling to
 * `AnthropicBrowserProvider` that reuses the same system prompt, tool schemas, and pure tool
 * runners — only the wire format (request/response shapes, tool-call envelope) differs. Sends the
 * user's key directly from the browser (`Authorization: Bearer`), so the app stays server-free.
 */
export class OpenAiBrowserProvider implements AiProvider {
  constructor(
    private readonly apiKey: string,
    private readonly model: string = OPENAI_DEFAULT_MODEL,
    private readonly target: TargetId = DEFAULT_TARGET,
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
   * List the chat models this key can access. OpenAI returns the full catalog in a single
   * response (no pagination cursor). Throws on a non-OK response so callers can fall back to the
   * static catalog.
   */
  async listModels(): Promise<ModelInfo[]> {
    const response = await fetch(OPENAI_MODELS_URL, {
      headers: this.headers(),
      signal: AbortSignal.timeout(MODELS_TIMEOUT_MS),
    });
    if (!response.ok) {
      const errorBody = await response.text();
      throw new Error(`OpenAI Models API error (${response.status}): ${errorBody}`);
    }
    return parseOpenAiModels(await response.json());
  }

  /** The shared auth headers every OpenAI request needs in the browser. */
  private headers(): Record<string, string> {
    return {
      "content-type": "application/json",
      authorization: `Bearer ${this.apiKey}`,
    };
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
    const response = await fetch(OPENAI_API_URL, {
      method: "POST",
      headers: this.headers(),
      signal: AbortSignal.timeout(MESSAGE_TIMEOUT_MS),
      body: JSON.stringify({
        model: this.model,
        // `max_completion_tokens` is the current param name and is accepted by reasoning models
        // (o-series) that reject the legacy `max_tokens`.
        max_completion_tokens: MAX_COMPLETION_TOKENS,
        messages: [{ role: "system", content: system }, ...messages],
        ...(tools ? { tools } : {}),
        ...(toolChoice ? { tool_choice: toolChoice } : {}),
      }),
    });

    if (!response.ok) {
      const errorBody = await response.text();
      throw new Error(`OpenAI API error (${response.status}): ${errorBody}`);
    }

    return (await response.json()) as OpenAiChatResponse;
  }
}
