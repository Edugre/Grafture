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
} from "@grafture/core";

import { buildCopilotSystemPrompt, buildRerankSystemPrompt } from "../copilot/systemPrompt.js";
import { COPILOT_RESPONSE_TOOL, parseResponseArgs } from "../copilot/responseTool.js";
import { parseCopilotResponse } from "../copilot/parseResponse.js";
import { PREVIEW_EXPORT_TOOL, runExportPreview } from "../copilot/exportPreviewTool.js";
import { INSPECT_SOURCE_TOOL, runInspectSource } from "../copilot/inspectSourceTool.js";
import { PROBE_JOIN_TOOL, runProbeJoin } from "../copilot/probeJoinTool.js";
import { parseRankingResponse } from "../suggest/rerank.js";

/** Cap on investigation round-trips within a single propose() before we force a finalization. */
const MAX_PREVIEW_ITERATIONS = 6;
/**
 * On a fresh derivation (no history, sources present) `submit_schema_response` is withheld for
 * this many inner rounds, so the model spends them on probe/inspect/preview evidence-gathering
 * instead of finalizing from the prompt digest alone. Correction turns keep submit from round
 * one — they already investigated.
 */
const INVESTIGATION_ROUNDS = 2;

/**
 * Appended to the system prompt in JSON mode. The static prompt already defines every action op and
 * the `{ reply, actions, status }` shape (via the tool description that defers to it); this only
 * overrides the "call submit_schema_response" workflow with "emit the JSON directly", for runtimes
 * that can't do tool calls.
 */
const JSON_OUTPUT_INSTRUCTION = [
  "<output_format>",
  "This runtime does not support tool calls. Do NOT attempt to call any tool or function.",
  "Ignore any earlier instruction to call submit_schema_response.",
  "Respond with ONLY a single JSON object and nothing else — no markdown fences, no prose outside it:",
  '{ "reply": string, "actions": [ /* action objects using the ops above; [] for a plain question */ ], "status": "complete" | "needs_revision" | "blocked" }',
  "</output_format>",
].join("\n");

// A local runtime signals "no function calling" either by rejecting the request outright (these
// substrings appear in the error body) or by answering in prose. Both route to the JSON fallback.
const TOOL_UNSUPPORTED_PATTERNS = [
  /does not support tools/i,
  /tools? (?:are|is)? ?not supported/i,
  /unsupported.*\btool/i,
  /tool[_ ]?choice/i,
  /function[_ ]?call(?:ing)? (?:is )?not/i,
];

/** True when an error message reads like the runtime can't do tool calls (vs an unrelated failure). */
function isToolUnsupportedError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return TOOL_UNSUPPORTED_PATTERNS.some((pattern) => pattern.test(message));
}

/**
 * Thrown inside the tool loop when the model returns no tool call and JSON fallback is enabled, so
 * `propose` can retry in JSON mode. Internal control flow only — never surfaced to the user.
 */
class ToolCallMissingError extends Error {}

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
  /**
   * Optional: when the tool loop can't run (the runtime rejects `tools`/`tool_choice`, or the model
   * answers in prose instead of calling a tool), retry once in prompt-based JSON mode — no tools,
   * an explicit "reply with only JSON" instruction, parsed from the text. Enabled only for local
   * runtimes, where many models lack function calling; hosted providers keep the strict tool loop.
   */
  allowJsonFallback?: boolean;
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
  /**
   * Latched once a runtime hard-rejects tools, so later turns in the same conversation skip the
   * doomed tool attempt and go straight to JSON mode. Set ONLY on a hard rejection — never from a
   * one-off prose reply, since a model may call tools intermittently. Instance-scoped: a fresh
   * provider (new key/model/endpoint) starts clean.
   */
  private toolsUnsupported = false;

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

    // This runtime already proved it can't do tool calls — don't pay the rejection round-trip again
    // (the copilot's correction loop calls propose up to 4× per message).
    if (this.config.allowJsonFallback && this.toolsUnsupported) {
      return this.proposeJsonMode(system, message, history);
    }

    try {
      return await this.proposeWithTools(system, schema, sources, message, history);
    } catch (error) {
      // A runtime without function calling either rejects the request (isToolUnsupportedError — a
      // durable property, so latch it) or answers in prose (ToolCallMissingError — possibly a
      // one-off, so don't latch). Either way, when fallback is enabled, retry once in JSON mode.
      if (this.config.allowJsonFallback) {
        const hardReject = isToolUnsupportedError(error);
        if (hardReject || error instanceof ToolCallMissingError) {
          if (hardReject) {
            this.toolsUnsupported = true;
          }
          return this.proposeJsonMode(system, message, history);
        }
      }
      throw error;
    }
  }

  /** The agentic tool loop (the path tool-capable models take). */
  private async proposeWithTools(
    system: string,
    schema: Schema,
    sources: ParsedSource[],
    message: string,
    history: ConversationTurn[],
  ): Promise<AiProviderResult> {
    const investigationTools = [PREVIEW_EXPORT_TOOL, INSPECT_SOURCE_TOOL, PROBE_JOIN_TOOL];
    let messages: OpenAiMessage[] = [
      ...history.map((turn) => ({ role: turn.role, content: turn.content })),
      { role: "user", content: message },
    ];
    // Fresh derivations get an evidence-gathering phase before submit is even offered;
    // follow-up/correction turns (history present) or source-less questions do not.
    const withheldRounds = history.length === 0 && sources.length > 0 ? INVESTIGATION_ROUNDS : 0;

    // Agentic tool loop: the model may call preview_export, inspect_source, or probe_join (all
    // read-only, in-memory) then finalize with submit_schema_response. `tool_choice: "required"`
    // forces a tool call every step so the loop never dead-ends on a stray sentence. The tool
    // list is built per round: submit is withheld while investigating.
    for (let iteration = 0; iteration < MAX_PREVIEW_ITERATIONS; iteration += 1) {
      const tools = (
        iteration < withheldRounds
          ? investigationTools
          : [...investigationTools, COPILOT_RESPONSE_TOOL]
      ).map(toOpenAiTool);
      const data = await this.request(system, messages, tools, "required");
      const msg = data.choices?.[0]?.message;
      const toolCalls = msg?.tool_calls ?? [];

      if (toolCalls.some((call) => call.function.name === COPILOT_RESPONSE_TOOL.name)) {
        return this.finalizeMessage(msg);
      }
      if (!msg || toolCalls.length === 0) {
        // No tool call. With fallback enabled, bail to JSON mode instead of guessing at prose;
        // otherwise parse whatever came back (text fallback) or surface it as blocked.
        if (this.config.allowJsonFallback) {
          throw new ToolCallMissingError("model returned no tool call");
        }
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

  /**
   * Prompt-based JSON fallback for runtimes without function calling: one plain completion (no
   * tools) with an explicit "reply with only JSON" instruction appended, parsed from the text via
   * the shared {@link parseCopilotResponse} (which tolerates fences/surrounding prose). The model
   * still sees the full schema + sample values in the system prompt, so content-aware modeling is
   * preserved — it just can't request more samples via inspect_source.
   */
  private async proposeJsonMode(
    system: string,
    message: string,
    history: ConversationTurn[],
  ): Promise<AiProviderResult> {
    const messages: OpenAiMessage[] = [
      ...history.map((turn) => ({ role: turn.role, content: turn.content })),
      { role: "user", content: message },
    ];
    const data = await this.request(`${system}\n\n${JSON_OUTPUT_INSTRUCTION}`, messages);
    const text = data.choices?.[0]?.message?.content ?? "";
    if (!text.trim()) {
      return { reply: "The model returned no usable response.", actions: [], status: "blocked" };
    }
    const parsed = parseCopilotResponse(text);
    if ("error" in parsed) {
      return { reply: `${text}\n\n(${parsed.error})`.trim(), actions: [], status: "blocked" };
    }
    return parsed;
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
    if (call.function.name === PROBE_JOIN_TOOL.name) {
      return runProbeJoin(sources, args);
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
