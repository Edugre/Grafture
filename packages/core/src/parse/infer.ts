import type { InferredType } from "./types.js";
import { isNullToken } from "./sample.js";

export const TYPE_INFERENCE_THRESHOLD = 0.95;

const BOOL_VALUES = new Set(["true", "false", "yes", "no", "t", "f"]);

const INT_PATTERN = /^[+-]?\d+$/;

// A zero-padded value ("01234") is an identifier, not a number: casting it to int drops the
// zeros and breaks joins (the HRSA↔OPAIS grant-number case). "0" itself stays numeric.
const LEADING_ZERO_PATTERN = /^[+-]?0\d/;

const NUMERIC_PATTERN = /^[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$/;

const DATE_PATTERNS = [
  /^\d{4}-\d{2}-\d{2}$/,
  /^\d{4}\/\d{2}\/\d{2}$/,
  /^\d{2}\/\d{2}\/\d{4}$/,
] as const;

// A value with a time component is a point in time, not a calendar date — collapsing it to
// `date` silently drops the time of day on export (timestamptz/DateTime round-trip properly).
const TIMESTAMP_PATTERNS = [
  /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2})?(\.\d+)?(Z|[+-]\d{2}:?\d{2})?$/,
] as const;

function isNonEmpty(value: string): boolean {
  return !isNullToken(value);
}

function meetsThreshold(values: string[], matches: (value: string) => boolean): boolean {
  if (values.length === 0) {
    return false;
  }
  const matchCount = values.filter(matches).length;
  return matchCount / values.length >= TYPE_INFERENCE_THRESHOLD;
}

function matchesBool(value: string): boolean {
  return BOOL_VALUES.has(value.toLowerCase());
}

function matchesInt(value: string): boolean {
  return INT_PATTERN.test(value) && !LEADING_ZERO_PATTERN.test(value);
}

function hasFractionalPart(value: string): boolean {
  return value.includes(".");
}

function matchesNumeric(value: string): boolean {
  return NUMERIC_PATTERN.test(value) && !LEADING_ZERO_PATTERN.test(value);
}

function matchesDate(value: string): boolean {
  return DATE_PATTERNS.some((pattern) => pattern.test(value));
}

function matchesTimestamp(value: string): boolean {
  return TIMESTAMP_PATTERNS.some((pattern) => pattern.test(value));
}

export type TypeInferenceRule = {
  type: InferredType;
  matches: (values: string[]) => boolean;
};

export const TYPE_INFERENCE_RULES: readonly TypeInferenceRule[] = [
  {
    type: "bool",
    matches: (values) => meetsThreshold(values, matchesBool),
  },
  {
    type: "int",
    matches: (values) => meetsThreshold(values, matchesInt),
  },
  {
    type: "numeric",
    matches: (values) => values.some(hasFractionalPart) && meetsThreshold(values, matchesNumeric),
  },
  {
    type: "timestamp",
    matches: (values) => meetsThreshold(values, matchesTimestamp),
  },
  {
    type: "date",
    matches: (values) => meetsThreshold(values, matchesDate),
  },
  {
    type: "text",
    matches: () => true,
  },
];

export function inferType(values: string[]): InferredType {
  const nonEmpty = values.filter(isNonEmpty);
  if (nonEmpty.length === 0) {
    return "text";
  }

  for (const rule of TYPE_INFERENCE_RULES) {
    if (rule.matches(nonEmpty)) {
      return rule.type;
    }
  }

  return "text";
}
