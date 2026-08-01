/**
 * A failure to read or parse a source file.
 *
 * `message` is the *reason alone* and never names the file. The name travels separately in
 * {@link ParseError.sourceName} because every caller already knows which file it handed us, and
 * most of them are rendering it right next to the error — a message that embedded the name
 * produced `broken.json: Unable to parse JSON in "broken.json"`. Callers that show the file
 * elsewhere (a row heading, a chip) render `message` on its own; callers aggregating several
 * failures into one line compose the two themselves.
 */
export class ParseError extends Error {
  /** The file the failure belongs to, when the thrower knew it. */
  readonly sourceName: string | undefined;

  constructor(message: string, sourceName?: string) {
    super(message);
    this.name = "ParseError";
    this.sourceName = sourceName;
  }
}
