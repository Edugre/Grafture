import { ParseError } from "./errors.js";
import type { Source } from "./types.js";
import { buildSourceField, dedupeNames, resolveMakeId, type ParseOptions } from "./util.js";
import { MAX_ROW_TUPLES, sampleScanRows } from "./sample.js";

const MAX_KEY_SCAN_RECORDS = 200;
const MAX_FLATTEN_DEPTH = 2;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** The records in `value` if it is an array containing at least one object, else undefined. */
function asRecordArray(value: unknown): Record<string, unknown>[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }
  const records = value.filter(isRecord);
  return records.length > 0 ? records : undefined;
}

/**
 * Resolve the list of records to model as rows. A bare array is used directly. For a top-level
 * object we unwrap the common envelope shape — `{ "data": [ {...}, ... ] }`, `{ "results": [...] }`
 * — by using the largest property that holds an array of objects; otherwise the object itself is
 * treated as a single record. (Arrays of scalars are left alone, so `{ "tags": ["a","b"] }` stays
 * a single record with a `tags` field rather than being mistaken for the row set.)
 */
function extractRecords(parsed: unknown): Record<string, unknown>[] {
  if (Array.isArray(parsed)) {
    return parsed.filter(isRecord);
  }

  if (isRecord(parsed)) {
    let best: Record<string, unknown>[] | undefined;
    for (const value of Object.values(parsed)) {
      const candidate = asRecordArray(value);
      if (candidate && (!best || candidate.length > best.length)) {
        best = candidate;
      }
    }
    return best ?? [parsed];
  }

  return [];
}

function scalarToString(value: unknown): string {
  if (value === null || value === undefined) {
    return "";
  }
  return String(value);
}

function pathSegmentCount(path: string): number {
  return path === "" ? 0 : path.split(".").length;
}

function flattenValue(
  value: unknown,
  path: string,
  out: Map<string, string[]>,
  order: string[],
): void {
  if (Array.isArray(value)) {
    const stringified = JSON.stringify(value);
    appendFieldValue(out, order, path, stringified);
    return;
  }

  if (isRecord(value)) {
    if (pathSegmentCount(path) >= MAX_FLATTEN_DEPTH) {
      appendFieldValue(out, order, path, JSON.stringify(value));
      return;
    }

    for (const [key, nestedValue] of Object.entries(value)) {
      const nestedPath = path === "" ? key : `${path}.${key}`;
      flattenValue(nestedValue, nestedPath, out, order);
    }
    return;
  }

  appendFieldValue(out, order, path, scalarToString(value));
}

function appendFieldValue(
  out: Map<string, string[]>,
  order: string[],
  path: string,
  value: string,
): void {
  if (!out.has(path)) {
    out.set(path, []);
    order.push(path);
  }
  out.get(path)?.push(value);
}

function unionFieldKeys(records: Record<string, unknown>[]): string[] {
  const order: string[] = [];
  const seen = new Set<string>();
  const limit = Math.min(records.length, MAX_KEY_SCAN_RECORDS);

  for (let i = 0; i < limit; i++) {
    const record = records[i];
    if (!record) {
      continue;
    }
    const fieldOrder: string[] = [];
    const values = new Map<string, string[]>();
    flattenValue(record, "", values, fieldOrder);
    for (const key of fieldOrder) {
      if (!seen.has(key)) {
        seen.add(key);
        order.push(key);
      }
    }
  }

  return order;
}

function recordFieldValues(record: Record<string, unknown>): Map<string, string> {
  const order: string[] = [];
  const values = new Map<string, string[]>();
  flattenValue(record, "", values, order);

  const flattened = new Map<string, string>();
  for (const key of order) {
    const fieldValues = values.get(key) ?? [];
    flattened.set(key, fieldValues[0] ?? "");
  }
  return flattened;
}

export function parseJson(input: string, name: string, opts?: ParseOptions): Source {
  let parsed: unknown;
  try {
    parsed = JSON.parse(input);
  } catch {
    throw new ParseError(`Unable to parse JSON in "${name}"`);
  }

  const records = extractRecords(parsed);

  const scanRecords = sampleScanRows(records);
  const keyOrder = unionFieldKeys(scanRecords);
  const dedupedNames = dedupeNames(keyOrder);

  // Flatten each record exactly once; both the per-column values and the row tuples
  // below project from this pass (recursive flattening is the expensive part).
  const flattenedRecords = scanRecords.map((record) => recordFieldValues(record));

  const columnValues = new Map<string, string[]>();
  for (const name of keyOrder) {
    columnValues.set(name, []);
  }

  for (const flattened of flattenedRecords) {
    for (const key of keyOrder) {
      const values = columnValues.get(key);
      if (!values) {
        continue;
      }
      values.push(flattened.get(key) ?? "");
    }
  }

  const fields = dedupedNames.map((fieldName, index) => {
    const originalKey = keyOrder[index] ?? fieldName;
    const values = columnValues.get(originalKey) ?? [];
    return buildSourceField(values, fieldName);
  });

  const sampleRows = sampleScanRows(flattenedRecords, MAX_ROW_TUPLES).map((flattened) =>
    keyOrder.map((key) => flattened.get(key) ?? ""),
  );

  return {
    id: resolveMakeId(opts)(),
    name,
    kind: "json",
    fields,
    sampleRows,
    // Every extracted record is a row, uncapped — not limited to the scanned slice.
    rowCount: records.length,
  };
}
