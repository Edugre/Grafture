import type { CopilotStatus } from "@schema-studio/core";

export type ParsedCopilotResponse = {
  reply: string;
  actions: unknown[];
  status: CopilotStatus;
};

function parseStatus(value: unknown): CopilotStatus {
  // Default to needs_revision when absent/unknown: it never forces an early "blocked"
  // stop, and a clean apply (zero rejections) terminates the loop regardless.
  return value === "complete" || value === "blocked" || value === "needs_revision"
    ? value
    : "needs_revision";
}

export type ParseCopilotResponseError = {
  error: string;
};

function extractJsonObject(text: string): string {
  const fenceMatch = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fenceMatch?.[1]) {
    return fenceMatch[1].trim();
  }

  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start !== -1 && end > start) {
    return text.slice(start, end + 1);
  }

  return text.trim();
}

/** Parse model text into { reply, actions }. Tolerates markdown code fences around JSON. */
export function parseCopilotResponse(
  text: string,
): ParsedCopilotResponse | ParseCopilotResponseError {
  const jsonText = extractJsonObject(text);

  let parsed: unknown;
  try {
    parsed = JSON.parse(jsonText);
  } catch {
    return { error: "Copilot response was not valid JSON." };
  }

  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { error: "Copilot response must be a JSON object with reply and actions." };
  }

  const record = parsed as Record<string, unknown>;
  const reply = typeof record["reply"] === "string" ? record["reply"] : "";

  // A present-but-non-array `actions` is a malformed payload — surface it rather than
  // silently coercing to [] and dropping whatever the model intended.
  const rawActions = record["actions"];
  if (rawActions !== undefined && !Array.isArray(rawActions)) {
    return { error: "Copilot returned 'actions' in an unexpected shape (expected an array)." };
  }
  const actions = Array.isArray(rawActions) ? rawActions : [];

  return { reply, actions, status: parseStatus(record["status"]) };
}
