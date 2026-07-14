import type {
  AiProvider,
  AiProviderResult,
  ConversationTurn,
  ModelInfo,
  ParsedSource,
  ProposeOptions,
  Schema,
  SuggestionDigest,
  SuggestionRanking,
  TargetId,
} from "@grafture/core";
import { DEFAULT_TARGET } from "@grafture/core";

import {
  buildDynamicContext,
  buildRerankSystemPrompt,
  buildStaticInstructions,
} from "../copilot/systemPrompt.js";
import { COPILOT_RESPONSE_TOOL, parseToolUseResponse } from "../copilot/responseTool.js";
import { PREVIEW_EXPORT_TOOL, runExportPreview } from "../copilot/exportPreviewTool.js";
import { INSPECT_SOURCE_TOOL, runInspectSource } from "../copilot/inspectSourceTool.js";
import { PROBE_JOIN_TOOL, runProbeJoin } from "../copilot/probeJoinTool.js";
import { parseRankingResponse } from "../suggest/rerank.js";
import { DEFAULT_MODEL, parseModelsPage } from "./models.js";

const ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_MODELS_URL = "https://api.anthropic.com/v1/models";
const ANTHROPIC_VERSION = "2023-06-01";

// Without a deadline a stalled connection hangs propose() forever — the agent loop's cancel
// check only runs between rounds, so the whole copilot wedges. Generation can legitimately take
// a while at 4096 max_tokens; listing models cannot.
const MESSAGE_TIMEOUT_MS = 120_000;
const MODELS_TIMEOUT_MS = 15_000;

/** Cap on investigation round-trips within a single propose() before we force a finalization. */
const MAX_PREVIEW_ITERATIONS = 6;
/**
 * On a fresh derivation (caller-declared `intent: "derive"`, sources present)
 * `submit_schema_response` is withheld for this many inner rounds, so the model spends them on
 * probe/inspect/preview evidence-gathering instead of finalizing from the prompt digest alone.
 * Chat turns and correction rounds keep submit from round one — a plain question must not be
 * forced through investigation, and correction turns already investigated.
 */
const INVESTIGATION_ROUNDS = 2;

type AnthropicContentBlock = {
  type: string;
  text?: string;
  name?: string;
  input?: unknown;
  id?: string;
  tool_use_id?: string;
  content?: unknown;
};

type AnthropicMessageResponse = {
  content: AnthropicContentBlock[];
};

type SystemBlock = { type: "text"; text: string; cache_control?: { type: "ephemeral" } };
type ToolSpec = { name: string; description: string; input_schema: unknown };
type ToolChoice = { type: "tool"; name: string } | { type: "any" } | { type: "auto" };
type MessageContent = string | AnthropicContentBlock[];
type ProviderMessage = { role: "user" | "assistant"; content: MessageContent };

export class AnthropicBrowserProvider implements AiProvider {
  constructor(
    private readonly apiKey: string,
    private readonly model: string = DEFAULT_MODEL,
    private readonly target: TargetId = DEFAULT_TARGET,
  ) {}

  async propose(
    schema: Schema,
    sources: ParsedSource[],
    message: string,
    history: ConversationTurn[] = [],
    options?: ProposeOptions,
  ): Promise<AiProviderResult> {
    // Two system blocks with the cache breakpoint between them: the static instructions never
    // change per target, so they hit the prompt cache on every turn; the dynamic block re-embeds
    // the live schema + source samples and is invalidated by canvas edits — but no longer drags
    // the instruction prefix with it. History is sent after `system`, so it never invalidates
    // either block.
    const systemBlocks: SystemBlock[] = [
      {
        type: "text",
        text: buildStaticInstructions(this.target),
        cache_control: { type: "ephemeral" },
      },
      { type: "text", text: buildDynamicContext(schema, sources) },
    ];
    const investigationTools = [PREVIEW_EXPORT_TOOL, INSPECT_SOURCE_TOOL, PROBE_JOIN_TOOL];
    let messages: ProviderMessage[] = [...history, { role: "user", content: message }];
    // Fresh derivations (declared by the caller, never inferred from history length — a plain
    // first-turn question must not be forced to fabricate tool calls) get an evidence-gathering
    // phase before submit is even offered; correction rounds (history present) do not re-withhold.
    const withheldRounds =
      options?.intent === "derive" && history.length === 0 && sources.length > 0
        ? INVESTIGATION_ROUNDS
        : 0;

    // Agentic tool loop: the model may call preview_export (see the migration its design would
    // generate), inspect_source (see more of a column's values), or probe_join (verify a join
    // hypothesis) — all read-only, in-memory — then finalize with submit_schema_response.
    // `tool_choice: any` forces a tool call every step, so the loop never dead-ends on a stray
    // sentence. The tool list is built per round: submit is withheld while investigating.
    for (let iteration = 0; iteration < MAX_PREVIEW_ITERATIONS; iteration += 1) {
      const tools =
        iteration < withheldRounds
          ? investigationTools
          : [...investigationTools, COPILOT_RESPONSE_TOOL];
      const data = await this.request(systemBlocks, messages, tools, { type: "any" });

      if (data.content.some((block) => isToolUse(block, COPILOT_RESPONSE_TOOL.name))) {
        return this.finalizeResponse(data);
      }

      const calls = data.content.filter((block) =>
        investigationTools.some((tool) => isToolUse(block, tool.name)),
      );
      if (calls.length === 0) {
        // No recognized tool — parse whatever came back (text fallback) or surface it as blocked.
        return this.finalizeResponse(data);
      }

      // Answer every call (the API requires a tool_result per tool_use), then let the model
      // continue from what it saw.
      const toolResults: AnthropicContentBlock[] = calls.map((call) => ({
        type: "tool_result",
        tool_use_id: call.id ?? "",
        content:
          call.name === PREVIEW_EXPORT_TOOL.name
            ? runExportPreview(schema, call.input)
            : call.name === PROBE_JOIN_TOOL.name
              ? runProbeJoin(sources, call.input, schema)
              : runInspectSource(sources, call.input),
      }));
      messages = [
        ...messages,
        { role: "assistant", content: data.content },
        { role: "user", content: toolResults },
      ];
    }

    // Spent the preview budget without finalizing — force one submission so the turn still resolves.
    const finalData = await this.request(systemBlocks, messages, [COPILOT_RESPONSE_TOOL], {
      type: "tool",
      name: COPILOT_RESPONSE_TOOL.name,
    });
    return this.finalizeResponse(finalData);
  }

  /** Parse a finalizing response, surfacing a malformed payload as a blocked turn. */
  private finalizeResponse(data: AnthropicMessageResponse): AiProviderResult {
    const parsed = parseToolUseResponse(data.content);
    if ("error" in parsed) {
      // A malformed payload can't be acted on or revised — surface it and stop the loop.
      return {
        reply: `${firstText(data.content) ?? ""}\n\n(${parsed.error})`.trim(),
        actions: [],
        status: "blocked",
      };
    }
    return parsed;
  }

  async rankSuggestions(
    schema: Schema,
    sources: ParsedSource[],
    candidates: SuggestionDigest[],
  ): Promise<SuggestionRanking[]> {
    const systemPrompt = buildRerankSystemPrompt(schema, sources);
    const userMessage = `Rank these suggestions:\n${JSON.stringify({ suggestions: candidates })}`;
    const data = await this.request(systemPrompt, [{ role: "user", content: userMessage }]);

    const parsed = parseRankingResponse(firstText(data.content) ?? "");
    if ("error" in parsed) {
      // Let the caller fall back to the deterministic order rather than act on garbage.
      throw new Error(parsed.error);
    }
    return parsed;
  }

  /**
   * List the Claude models this key can access, newest-first. Paginates the Models API until
   * `has_more` is false (one page covers the current catalog, but the loop stays correct). Throws
   * on a non-OK response so callers can fall back to the static catalog.
   */
  async listModels(): Promise<ModelInfo[]> {
    const models: ModelInfo[] = [];
    let after: string | undefined;

    // Bound the loop defensively so a misbehaving cursor can't spin forever.
    for (let page = 0; page < 20; page += 1) {
      const url = new URL(ANTHROPIC_MODELS_URL);
      url.searchParams.set("limit", "100");
      if (after) {
        url.searchParams.set("after_id", after);
      }

      const response = await fetch(url, {
        headers: this.headers(),
        signal: AbortSignal.timeout(MODELS_TIMEOUT_MS),
      });
      if (!response.ok) {
        const errorBody = await response.text();
        throw new Error(`Anthropic Models API error (${response.status}): ${errorBody}`);
      }

      const parsed = parseModelsPage(await response.json());
      models.push(...parsed.models);
      if (!parsed.hasMore || !parsed.lastId) {
        break;
      }
      after = parsed.lastId;
    }

    return models;
  }

  /** The shared auth/version headers every Anthropic request needs in the browser. */
  private headers(): Record<string, string> {
    return {
      "content-type": "application/json",
      "x-api-key": this.apiKey,
      "anthropic-version": ANTHROPIC_VERSION,
      "anthropic-dangerous-direct-browser-access": "true",
    };
  }

  /**
   * POST a single completion and return the parsed response. Shared by propose (which forces the
   * response tool) and rankSuggestions (plain text). Passing `tools` + `toolChoice` opts into
   * tool-use; omitting them yields a normal text completion.
   */
  private async request(
    system: string | SystemBlock[],
    messages: ProviderMessage[],
    tools?: ToolSpec[],
    toolChoice?: ToolChoice,
  ): Promise<AnthropicMessageResponse> {
    // A bare string becomes a single cached block (the rerank path); propose passes its own
    // blocks so the static/dynamic cache split is preserved.
    const systemBlocks: SystemBlock[] =
      typeof system === "string"
        ? [{ type: "text", text: system, cache_control: { type: "ephemeral" } }]
        : system;

    const response = await fetch(ANTHROPIC_API_URL, {
      method: "POST",
      headers: this.headers(),
      signal: AbortSignal.timeout(MESSAGE_TIMEOUT_MS),
      body: JSON.stringify({
        model: this.model,
        max_tokens: 4096,
        system: systemBlocks,
        messages,
        ...(tools ? { tools } : {}),
        ...(toolChoice ? { tool_choice: toolChoice } : {}),
      }),
    });

    if (!response.ok) {
      const errorBody = await response.text();
      throw new Error(`Anthropic API error (${response.status}): ${errorBody}`);
    }

    return (await response.json()) as AnthropicMessageResponse;
  }
}

/** First non-empty text block in an Anthropic content array, or undefined when there is none. */
function firstText(content: AnthropicContentBlock[]): string | undefined {
  return content.find((block) => block.type === "text" && block.text)?.text;
}

/** Is this content block a tool_use call for the named tool? */
function isToolUse(block: AnthropicContentBlock, name: string): boolean {
  return block.type === "tool_use" && block.name === name;
}
