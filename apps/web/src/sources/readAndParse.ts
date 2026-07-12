import { ParseError, parseSource, type Source } from "@grafture/core";

import { detectSourceKind } from "./detectKind.js";

/**
 * Read and parse one file into its sources. CSV/XLSX yield a single source; a JSON file whose
 * records hold arrays of objects yields the parent source first, then one child source per
 * array field (see core's `parseJson`).
 */
export async function readAndParseFile(
  file: File,
  opts?: { makeId?: () => string },
): Promise<Source[]> {
  const kind = detectSourceKind(file.name);

  if (!kind) {
    throw new ParseError(`Unsupported file type: ${file.name}`);
  }

  const content = kind === "xlsx" ? await file.arrayBuffer() : await file.text();

  return parseSource({ name: file.name, kind, content }, opts);
}
