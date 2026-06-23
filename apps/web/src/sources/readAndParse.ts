import { ParseError, parseSource, type Source } from "@schema-studio/core";

import { detectSourceKind } from "./detectKind.js";

export async function readAndParseFile(
  file: File,
  opts?: { makeId?: () => string },
): Promise<Source> {
  const kind = detectSourceKind(file.name);

  if (!kind) {
    throw new ParseError(`Unsupported file type: ${file.name}`);
  }

  const content = kind === "xlsx" ? await file.arrayBuffer() : await file.text();

  return parseSource({ name: file.name, kind, content }, opts);
}
