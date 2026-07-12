export { ParseError } from "./errors.js";
export {
  TYPE_INFERENCE_RULES,
  TYPE_INFERENCE_THRESHOLD,
  inferType,
  type TypeInferenceRule,
} from "./infer.js";
export {
  MAX_INFERENCE_VALUES,
  MAX_JOIN_VALUES,
  MAX_ROW_TUPLES,
  MAX_SAMPLES,
  MAX_SCAN_ROWS,
  MAX_TOP_VALUES,
  collectInferenceValues,
  collectJoinValues,
  collectSamples,
  collectStats,
  isNullToken,
  sampleScanRows,
} from "./sample.js";
export {
  FieldStatsSchema,
  InferredTypeSchema,
  SourceFieldSchema,
  SourceKindSchema,
  SourceSchema,
  ValueFrequencySchema,
  type FieldStats,
  type InferredType,
  type Source,
  type SourceField,
  type SourceKind,
  type ValueFrequency,
} from "./types.js";
export { defaultMakeId, dedupeNames, type ParseOptions } from "./util.js";
export { parseCsv } from "./csv.js";
export { parseJson } from "./json.js";
export { parseXlsx } from "./xlsx.js";

import type { SourceKind } from "./types.js";
import { parseCsv } from "./csv.js";
import { parseJson } from "./json.js";
import { parseXlsx } from "./xlsx.js";
import type { ParseOptions } from "./util.js";
import type { Source } from "./types.js";

/** @deprecated Use Source */
export type ParsedSource = Source;

/**
 * Parse one file into its sources. CSV/XLSX always yield a single-element array; JSON yields
 * the parent record set first, then one child source per top-level array-of-objects field.
 */
export function parseSource(
  input: {
    name: string;
    kind: SourceKind;
    content: string | ArrayBuffer | Uint8Array;
  },
  opts?: ParseOptions,
): Source[] {
  switch (input.kind) {
    case "csv":
      if (typeof input.content !== "string") {
        throw new Error("CSV content must be a string");
      }
      return [parseCsv(input.content, input.name, opts)];
    case "json":
      if (typeof input.content !== "string") {
        throw new Error("JSON content must be a string");
      }
      return parseJson(input.content, input.name, opts);
    case "xlsx":
      if (typeof input.content === "string") {
        throw new Error("XLSX content must be an ArrayBuffer or Uint8Array");
      }
      return [parseXlsx(input.content, input.name, opts)];
  }
}
