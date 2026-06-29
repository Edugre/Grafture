import type {
  AiProvider,
  AiProviderResult,
  ConversationTurn,
  ParsedSource,
  Schema,
  SuggestionDigest,
  SuggestionRanking,
} from "@schema-studio/core";

import { buildCopilotSystemPrompt, buildRerankSystemPrompt } from "../copilot/systemPrompt.js";
import { parseCopilotResponse } from "../copilot/parseResponse.js";
import { parseRankingResponse } from "../suggest/rerank.js";

const ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";
const DEFAULT_MODEL = "claude-sonnet-4-6";

type AnthropicMessageResponse = {
  content: Array<{ type: string; text?: string }>;
};

export class AnthropicBrowserProvider implements AiProvider {
  constructor(private readonly apiKey: string) {}

  async propose(
    schema: Schema,
    sources: ParsedSource[],
    message: string,
    history: ConversationTurn[] = [],
  ): Promise<AiProviderResult> {
    const systemPrompt = buildCopilotSystemPrompt(schema, sources);
    // The system prompt re-embeds the live schema + source samples each turn (the largest block).
    // Caching it means follow-up turns with an unchanged canvas reuse that prefix at ~0.1x cost;
    // history is sent after `system`, so it never invalidates this cache.
    const rawText = await this.send(systemPrompt, [...history, { role: "user", content: message }]);

    const parsed = parseCopilotResponse(rawText);
    if ("error" in parsed) {
      // A malformed payload can't be acted on or revised — surface it and stop the loop.
      return {
        reply: `${rawText}\n\n(${parsed.error})`,
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
    const rawText = await this.send(systemPrompt, [{ role: "user", content: userMessage }]);

    const parsed = parseRankingResponse(rawText);
    if ("error" in parsed) {
      // Let the caller fall back to the deterministic order rather than act on garbage.
      throw new Error(parsed.error);
    }
    return parsed;
  }

  /** POST a single completion and return the first text block. Shared by propose + rankSuggestions. */
  private async send(
    systemPrompt: string,
    messages: Array<{ role: "user" | "assistant"; content: string }>,
  ): Promise<string> {
    const response = await fetch(ANTHROPIC_API_URL, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-api-key": this.apiKey,
        "anthropic-version": ANTHROPIC_VERSION,
        "anthropic-dangerous-direct-browser-access": "true",
      },
      body: JSON.stringify({
        model: DEFAULT_MODEL,
        max_tokens: 4096,
        system: [{ type: "text", text: systemPrompt, cache_control: { type: "ephemeral" } }],
        messages,
      }),
    });

    if (!response.ok) {
      const errorBody = await response.text();
      throw new Error(`Anthropic API error (${response.status}): ${errorBody}`);
    }

    const data = (await response.json()) as AnthropicMessageResponse;
    return (
      data.content.find((block) => block.type === "text" && block.text)?.text ??
      "No response text returned."
    );
  }
}
