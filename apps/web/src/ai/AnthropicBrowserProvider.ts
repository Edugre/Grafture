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
import { COPILOT_RESPONSE_TOOL, parseToolUseResponse } from "../copilot/responseTool.js";
import { parseRankingResponse } from "../suggest/rerank.js";
import { DEFAULT_MODEL, parseModelsPage } from "./models.js";

const ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_MODELS_URL = "https://api.anthropic.com/v1/models";
const ANTHROPIC_VERSION = "2023-06-01";

type AnthropicContentBlock = { type: string; text?: string; name?: string; input?: unknown };

type AnthropicMessageResponse = {
  content: AnthropicContentBlock[];
};

type ToolSpec = { name: string; description: string; input_schema: unknown };

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
  ): Promise<AiProviderResult> {
    const systemPrompt = buildCopilotSystemPrompt(schema, sources, this.target);
    // The system prompt re-embeds the live schema + source samples each turn (the largest block).
    // Caching it means follow-up turns with an unchanged canvas reuse that prefix at ~0.1x cost;
    // history is sent after `system`, so it never invalidates this cache.
    //
    // Forcing the response tool (tool_choice) guarantees a well-formed { reply, actions, status }
    // envelope, so the loop no longer dead-ends on a stray sentence outside JSON.
    const data = await this.request(
      systemPrompt,
      [...history, { role: "user", content: message }],
      [COPILOT_RESPONSE_TOOL],
      { type: "tool", name: COPILOT_RESPONSE_TOOL.name },
    );

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

      const response = await fetch(url, { headers: this.headers() });
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
    systemPrompt: string,
    messages: Array<{ role: "user" | "assistant"; content: string }>,
    tools?: ToolSpec[],
    toolChoice?: { type: "tool"; name: string },
  ): Promise<AnthropicMessageResponse> {
    const response = await fetch(ANTHROPIC_API_URL, {
      method: "POST",
      headers: this.headers(),
      body: JSON.stringify({
        model: this.model,
        max_tokens: 4096,
        system: [{ type: "text", text: systemPrompt, cache_control: { type: "ephemeral" } }],
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
