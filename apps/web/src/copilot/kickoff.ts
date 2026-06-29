/**
 * Builds the Copilot instruction that kicks off an initial-schema draft from the New Project modal.
 * The source files themselves aren't embedded here — `AiProvider.propose` already receives the live
 * sources (with sample values) and the system prompt includes them — so this only frames the task
 * and the user's context (title + goals). Each context line is omitted when empty.
 */
export function buildInitialSchemaPrompt({
  name,
  description,
}: {
  name: string;
  description: string;
}): string {
  const lines = [
    "Draft an initial relational schema from the uploaded source files.",
    "Create a table for each file, infer primary keys and column types from the sample values, and add relationships wherever values overlap across files.",
  ];

  const context: string[] = [];
  if (name.trim()) {
    context.push(`Project: ${name.trim()}`);
  }
  if (description.trim()) {
    context.push(`Goals: ${description.trim()}`);
  }
  if (context.length > 0) {
    lines.push("", ...context);
  }

  return lines.join("\n");
}
