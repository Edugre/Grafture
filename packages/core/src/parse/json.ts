import { ParseError } from "./errors.js";
import type { Source, SourceField } from "./types.js";
import { buildSourceField, dedupeNames, resolveMakeId, type ParseOptions } from "./util.js";
import { MAX_ROW_TUPLES, collectJoinValues, sampleScanRows } from "./sample.js";

const MAX_KEY_SCAN_RECORDS = 200;
const MAX_FLATTEN_DEPTH = 2;

/**
 * Surrogate column names for unnested arrays-of-objects. `_rowId` (the parent record's index)
 * and `_parentId` (the child element's parent index) form a structural child→parent link that
 * travels via `Source.derivedFrom` lineage. Both are marked `synthetic: true` so the content
 * detectors skip them — a 0..N index must never outrank a real key or fake a join.
 */
const SYNTHETIC_ROW_ID = "_rowId";
const SYNTHETIC_PARENT_ID = "_parentId";

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

/**
 * Top-level keys whose value is an array of objects in at least one scanned record. These are
 * repeating sub-entities: each becomes a child `Source` instead of an opaque JSON-string column
 * on the parent. Arrays of scalars are NOT included — they keep the stringify path.
 */
function detectChildArrayKeys(records: Record<string, unknown>[]): string[] {
  const keys: string[] = [];
  const seen = new Set<string>();
  for (const record of records) {
    for (const [key, value] of Object.entries(record)) {
      if (!seen.has(key) && asRecordArray(value)) {
        seen.add(key);
        keys.push(key);
      }
    }
  }
  return keys;
}

/** A record paired with its index in the full record list (the index IS the `_rowId` value). */
type IndexedRecord = { record: Record<string, unknown>; index: number };

/** A child array element paired with the index of the parent record it came from. */
type ChildEntry = { element: Record<string, unknown>; parentIndex: number };

/** Mark a built field as a parser-injected surrogate the detectors must skip. */
function syntheticField(values: string[], name: string): SourceField {
  return { ...buildSourceField(values, name), synthetic: true };
}

/**
 * Build the per-key column arrays for a set of flattened records, in `keyOrder` order.
 * Missing keys read as "" so every column stays row-aligned.
 */
function buildColumns(flattened: Map<string, string>[], keyOrder: string[]): Map<string, string[]> {
  const columns = new Map<string, string[]>();
  for (const key of keyOrder) {
    columns.set(key, []);
  }
  for (const record of flattened) {
    for (const key of keyOrder) {
      columns.get(key)?.push(record.get(key) ?? "");
    }
  }
  return columns;
}

/**
 * Parse a JSON file into sources: the parent record set first, then one child `Source` per
 * top-level array-of-objects field (e.g. `file.json.npiNumbers`), so repeating sub-entities are
 * visible to the detectors as real columns instead of one opaque JSON-string blob. Parent and
 * child carry a synthetic `_rowId`/`_parentId` surrogate pair (excluded from all detectors) and
 * the child records its lineage in `derivedFrom` — the structural link the copilot models as a
 * child→parent FK. Sources whose records hold no arrays of objects yield a single-element array.
 */
export function parseJson(input: string, name: string, opts?: ParseOptions): Source[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(input);
  } catch {
    throw new ParseError(`Unable to parse JSON in "${name}"`);
  }

  const makeId = resolveMakeId(opts);
  const records = extractRecords(parsed);
  const indexed: IndexedRecord[] = records.map((record, index) => ({ record, index }));
  const scanIndexed = sampleScanRows(indexed);
  const scanRecords = scanIndexed.map((entry) => entry.record);

  const keyOrder = unionFieldKeys(scanRecords);
  const childKeys = detectChildArrayKeys(scanRecords);
  const childKeySet = new Set(childKeys);
  // Array-of-objects columns are represented by their child source, not a JSON-string blob.
  const parentKeys = keyOrder.filter((key) => !childKeySet.has(key));
  const hasChildren = childKeys.length > 0;

  // Flatten each scanned record exactly once; both the per-column values and the row tuples
  // below project from this pass (recursive flattening is the expensive part).
  const flattenedRecords = scanRecords.map((record) => recordFieldValues(record));
  const columnValues = buildColumns(flattenedRecords, parentKeys);

  // Wide join-discovery pass (PR-0): when the scan window narrowed the file, traverse ALL
  // records once more for the scalar columns so join/containment detection sees the real value
  // sets. The flattened tuples are transient — only each column's distinct set survives.
  const needWidePass = records.length > scanIndexed.length;
  let wideColumnValues: Map<string, string[]> | undefined;
  if (needWidePass) {
    wideColumnValues = new Map(parentKeys.map((key) => [key, []]));
    for (const record of records) {
      const flattened = recordFieldValues(record);
      for (const key of parentKeys) {
        wideColumnValues.get(key)?.push(flattened.get(key) ?? "");
      }
    }
  }

  const dedupedNames = dedupeNames(
    hasChildren ? [...parentKeys, SYNTHETIC_ROW_ID] : [...parentKeys],
  );
  const fields = parentKeys.map((originalKey, index) => {
    const fieldName = dedupedNames[index] ?? originalKey;
    const values = columnValues.get(originalKey) ?? [];
    const joinValues = wideColumnValues
      ? collectJoinValues(wideColumnValues.get(originalKey) ?? [])
      : undefined;
    return buildSourceField(values, fieldName, joinValues);
  });
  if (hasChildren) {
    const rowIdName = dedupedNames[parentKeys.length] ?? SYNTHETIC_ROW_ID;
    fields.push(
      syntheticField(
        scanIndexed.map((entry) => String(entry.index)),
        rowIdName,
      ),
    );
  }

  const sampleRows = sampleScanRows(scanIndexed, MAX_ROW_TUPLES).map((entry) => {
    const flattened = recordFieldValues(entry.record);
    const row = parentKeys.map((key) => flattened.get(key) ?? "");
    if (hasChildren) {
      row.push(String(entry.index));
    }
    return row;
  });

  const parentId = makeId();
  const parent: Source = {
    id: parentId,
    name,
    kind: "json",
    fields,
    sampleRows,
    // Every extracted record is a row, uncapped — not limited to the scanned slice.
    rowCount: records.length,
  };

  const children = childKeys.map((arrayField) =>
    buildChildSource(indexed, name, arrayField, parentId, makeId),
  );

  return [parent, ...children];
}

/**
 * Build the child `Source` for one array-of-objects field: its fields are the array elements'
 * flattened leaf keys plus the synthetic `_parentId` link back to the parent's `_rowId`. Child
 * element records are collected across ALL parent records (so `rowCount` is the true total and
 * the wide join pass covers the full leaf value sets); stats/samples/tuples come from an
 * evenly-sampled scan window, like any other source.
 */
function buildChildSource(
  indexed: IndexedRecord[],
  parentName: string,
  arrayField: string,
  parentId: string,
  makeId: () => string,
): Source {
  const entries: ChildEntry[] = [];
  for (const { record, index } of indexed) {
    const value = record[arrayField];
    if (!Array.isArray(value)) {
      continue;
    }
    for (const element of value) {
      if (isRecord(element)) {
        entries.push({ element, parentIndex: index });
      }
    }
  }

  const scanEntries = sampleScanRows(entries);
  const childKeyOrder = unionFieldKeys(scanEntries.map((entry) => entry.element));
  const flattenedChildren = scanEntries.map((entry) => recordFieldValues(entry.element));
  const columnValues = buildColumns(flattenedChildren, childKeyOrder);

  const needWidePass = entries.length > scanEntries.length;
  let wideColumnValues: Map<string, string[]> | undefined;
  if (needWidePass) {
    wideColumnValues = new Map(childKeyOrder.map((key) => [key, []]));
    for (const { element } of entries) {
      const flattened = recordFieldValues(element);
      for (const key of childKeyOrder) {
        wideColumnValues.get(key)?.push(flattened.get(key) ?? "");
      }
    }
  }

  const dedupedNames = dedupeNames([...childKeyOrder, SYNTHETIC_PARENT_ID]);
  const fields = childKeyOrder.map((originalKey, index) => {
    const fieldName = dedupedNames[index] ?? originalKey;
    const values = columnValues.get(originalKey) ?? [];
    const joinValues = wideColumnValues
      ? collectJoinValues(wideColumnValues.get(originalKey) ?? [])
      : undefined;
    return buildSourceField(values, fieldName, joinValues);
  });
  const parentIdName = dedupedNames[childKeyOrder.length] ?? SYNTHETIC_PARENT_ID;
  fields.push(
    syntheticField(
      scanEntries.map((entry) => String(entry.parentIndex)),
      parentIdName,
    ),
  );

  // Child tuples power composite-key/FD detection on the child; completeness is bounded by the
  // scanned parents (a child under MIN_TUPLE_ROWS silently yields no FD/composite findings).
  const sampleRows = sampleScanRows(scanEntries, MAX_ROW_TUPLES).map((entry) => {
    const flattened = recordFieldValues(entry.element);
    const row = childKeyOrder.map((key) => flattened.get(key) ?? "");
    row.push(String(entry.parentIndex));
    return row;
  });

  return {
    id: makeId(),
    name: `${parentName}.${arrayField}`,
    kind: "json",
    fields,
    sampleRows,
    rowCount: entries.length,
    derivedFrom: { parentId, arrayField },
  };
}
