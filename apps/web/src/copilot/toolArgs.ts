/** The shape every tool declaration in this directory shares, narrowed to what arg reading needs. */
type ToolWithRequiredArgs = {
  name: string;
  input_schema: { required: readonly string[] };
};

/** The required argument names of `T`, as a record of literal keys — see `requiredStringArgs`. */
export type RequiredStringArgs<T extends ToolWithRequiredArgs> = Record<
  T["input_schema"]["required"][number],
  string
>;

/**
 * Read a tool call's required string arguments, keyed by the tool's own `input_schema.required`.
 *
 * The value is the return *type*: the keys come from the declaration, so renaming a property
 * there turns every stale accessor in the runner into a compile error. Hand-written key literals
 * can't do that — they silently read `undefined`, coerce to `""`, and surface much later as a
 * bogus `no source named ""`, which reads like the model named a file that doesn't exist rather
 * than like a schema rename.
 *
 * A missing or non-string argument still becomes `""` rather than throwing: the model does omit
 * arguments, and the runners turn that into an error string handed back for self-correction.
 * Only the declaration-vs-runner drift is a compile error; a bad call from the model is not.
 */
export function requiredStringArgs<T extends ToolWithRequiredArgs>(
  tool: T,
  input: unknown,
): RequiredStringArgs<T> {
  const record =
    typeof input === "object" && input !== null ? (input as Record<string, unknown>) : {};
  const args: Record<string, string> = {};
  for (const key of tool.input_schema.required) {
    args[key] = typeof record[key] === "string" ? record[key] : "";
  }
  return args as RequiredStringArgs<T>;
}
