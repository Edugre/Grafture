import type { AiProvider, AiProviderResult, ParsedSource, Schema } from "@schema-studio/core";

const ANTHROPIC_API_URL = "https://api.anthropic.com/v1/messages";
const ANTHROPIC_VERSION = "2023-06-01";
const DEFAULT_MODEL = "claude-sonnet-4-20250514";

type AnthropicMessageResponse = {
  content: Array<{ type: string; text?: string }>;
};

export class AnthropicBrowserProvider implements AiProvider {
  constructor(private readonly apiKey: string) {}

  async propose(
    schema: Schema,
    sources: ParsedSource[],
    message: string,
  ): Promise<AiProviderResult> {
    const systemPrompt = [
      "You are Schema Studio's schema design copilot.",
      "Respond with concise guidance about relational schema design.",
      "Do not emit structured actions in this scaffold — reply in plain text only.",
      `Current schema: ${JSON.stringify(schema)}`,
      `Sources: ${JSON.stringify(sources)}`,
    ].join("\n");

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
        max_tokens: 1024,
        system: systemPrompt,
        messages: [{ role: "user", content: message }],
      }),
    });

    if (!response.ok) {
      const errorBody = await response.text();
      throw new Error(`Anthropic API error (${response.status}): ${errorBody}`);
    }

    const data = (await response.json()) as AnthropicMessageResponse;
    const reply =
      data.content.find((block) => block.type === "text" && block.text)?.text ??
      "No response text returned.";

    return { reply, actions: [] };
  }
}
