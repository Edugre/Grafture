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
    "First identify the distinct entities across ALL files — files are exports, not entities: merge files that describe the same entity, and split a file that mixes several entities or grains into separate tables. Do not create a table that merely mirrors a file.",
    'In your reply, start with the entity list and each table\'s grain ("one row = one ___") before the actions.',
    "Infer primary keys and column types from the sample values, and add relationships where identifier values overlap across sources.",
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
