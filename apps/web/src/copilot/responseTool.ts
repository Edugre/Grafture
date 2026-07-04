import {
  type ParseCopilotResponseError,
  type ParsedCopilotResponse,
  parseCopilotResponse,
  parseStatus,
} from "./parseResponse.js";

/**
 * The copilot returns its answer by **calling a tool** rather than emitting a JSON string. Forcing
 * a tool call (`tool_choice`) means the transport guarantees a well-formed `{ reply, actions,
 * status }` envelope — no fenced-JSON extraction, no "reply with ONLY JSON" that dead-ends the loop
 * on a stray sentence. The action shapes themselves stay loose here (`actions: object[]`) on
 * purpose: core's zod `applyActions` is the real validator and the single place invalid actions are
 * rejected and surfaced, so duplicating the op union as JSON Schema would only invite drift.
 */
export const COPILOT_RESPONSE_TOOL = {
  name: "submit_schema_response",
  description:
    "Return your reply to the user together with the schema actions to apply. Call this exactly once per turn; never answer in plain text.",
  input_schema: {
    type: "object" as const,
    properties: {
      reply: {
        type: "string",
        description: "Your explanation to the user, in prose.",
      },
      actions: {
        type: "array",
        items: { type: "object" },
        description:
          "Zero or more schema actions using the ops defined in the system prompt (table/field NAMES, not ids). Empty for a plain question.",
      },
      status: {
        type: "string",
        enum: ["complete", "needs_revision", "blocked"],
        description:
          "complete = request fully satisfied; needs_revision = still working or fixing rejected actions; blocked = cannot proceed (explain in reply).",
      },
    },
    required: ["reply", "status"],
  },
} as const;

type ContentBlock = {
  type?: string;
  text?: string;
  name?: string;
  input?: unknown;
};

/**
 * Pull the copilot's structured response out of an Anthropic `content` array. Prefers the forced
 * `tool_use` block; falls back to parsing a text block as JSON for the rare case the model answers
 * in prose anyway (e.g. a provider that ignores `tool_choice`), so a stray text reply still degrades
 * to the old path instead of erroring.
 */
export function parseToolUseResponse(
  content: unknown,
): ParsedCopilotResponse | ParseCopilotResponseError {
  if (!Array.isArray(content)) {
    return { error: "Copilot response had no content to read." };
  }

  const blocks = content as ContentBlock[];
  const toolUse = blocks.find(
    (block) => block.type === "tool_use" && block.name === COPILOT_RESPONSE_TOOL.name,
  );

  if (!toolUse) {
    const text = blocks.find(
      (block) => block.type === "text" && typeof block.text === "string",
    )?.text;
    if (typeof text === "string") {
      return parseCopilotResponse(text);
    }
    return { error: "Copilot did not return a structured tool response." };
  }

  const input = toolUse.input;
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    return { error: "Copilot tool call arguments had an unexpected shape." };
  }

  return parseResponseArgs(input as Record<string, unknown>);
}

/**
 * Validate a finalizing tool call's argument object into `{ reply, actions, status }`. Shared by
 * every provider so payload validation can't drift between them: the Anthropic block reader
 * ({@link parseToolUseResponse}) and the OpenAI provider (which `JSON.parse`s
 * `tool_call.function.arguments`) both funnel through here. A present-but-non-array `actions` is
 * treated as malformed and surfaced, never silently dropped.
 */
export function parseResponseArgs(
  record: Record<string, unknown>,
): ParsedCopilotResponse | ParseCopilotResponseError {
  const reply = typeof record["reply"] === "string" ? record["reply"] : "";

  const rawActions = record["actions"];
  if (rawActions !== undefined && !Array.isArray(rawActions)) {
    return { error: "Copilot returned 'actions' in an unexpected shape (expected an array)." };
  }
  const actions = Array.isArray(rawActions) ? rawActions : [];

  return { reply, actions, status: parseStatus(record["status"]) };
}
