import * as XLSX from "xlsx";

import { ParseError } from "./errors.js";
import type { Source } from "./types.js";
import { buildSourceField, dedupeNames, resolveMakeId, type ParseOptions } from "./util.js";
import { sampleScanRows } from "./sample.js";

function toArrayBuffer(input: ArrayBuffer | Uint8Array): ArrayBuffer {
  if (input instanceof ArrayBuffer) {
    return input;
  }
  return input.buffer.slice(input.byteOffset, input.byteOffset + input.byteLength) as ArrayBuffer;
}

function isRowEmpty(row: unknown[]): boolean {
  return row.every((cell) => cell === null || cell === undefined || String(cell).trim() === "");
}

function sheetRows(sheet: XLSX.WorkSheet): string[][] {
  const raw = XLSX.utils.sheet_to_json<unknown[]>(sheet, {
    header: 1,
    defval: "",
    raw: false,
  });

  return raw.map((row) => {
    if (!Array.isArray(row)) {
      return [];
    }
    return row.map((cell) => (cell === null || cell === undefined ? "" : String(cell)));
  });
}

function isSheetEmpty(rows: string[][]): boolean {
  if (rows.length === 0) {
    return true;
  }
  return rows.every(isRowEmpty);
}

export function parseXlsx(
  input: ArrayBuffer | Uint8Array,
  name: string,
  opts?: ParseOptions,
): Source {
  let workbook: XLSX.WorkBook;
  try {
    workbook = XLSX.read(toArrayBuffer(input), { type: "array" });
  } catch {
    throw new ParseError(`Unable to read workbook "${name}"`);
  }

  const nonEmptySheets: Array<{ name: string; rows: string[][] }> = [];

  for (const sheetName of workbook.SheetNames) {
    const sheet = workbook.Sheets[sheetName];
    if (!sheet) {
      continue;
    }
    const rows = sheetRows(sheet);
    if (!isSheetEmpty(rows)) {
      nonEmptySheets.push({ name: sheetName, rows });
    }
  }

  if (nonEmptySheets.length === 0) {
    return {
      id: resolveMakeId(opts)(),
      name,
      kind: "xlsx",
      fields: [],
      rowCount: 0,
    };
  }

  // Sheets are concatenated into one source; each contributes its data rows (header excluded).
  const rowCount = nonEmptySheets.reduce(
    (total, { rows }) => total + Math.max(rows.length - 1, 0),
    0,
  );

  const prefixSheets = nonEmptySheets.length > 1;
  const columnValues = new Map<string, string[]>();
  const fieldOrder: string[] = [];

  for (const { name: sheetName, rows } of nonEmptySheets) {
    const headerRow = rows[0] ?? [];
    const rawNames = headerRow.map((cell, index) => {
      const trimmed = cell.trim();
      const base = trimmed === "" ? `column_${index + 1}` : trimmed;
      return prefixSheets ? `${sheetName}.${base}` : base;
    });
    const fieldNames = dedupeNames(rawNames);
    const dataRows = sampleScanRows(rows.slice(1));

    for (let columnIndex = 0; columnIndex < fieldNames.length; columnIndex++) {
      const fieldName = fieldNames[columnIndex];
      if (!fieldName) {
        continue;
      }
      if (!columnValues.has(fieldName)) {
        fieldOrder.push(fieldName);
        columnValues.set(fieldName, []);
      }
      const values = columnValues.get(fieldName);
      if (!values) {
        continue;
      }
      for (const row of dataRows) {
        values.push(row[columnIndex] ?? "");
      }
    }
  }

  const fields = fieldOrder.map((fieldName) => {
    const values = columnValues.get(fieldName) ?? [];
    return buildSourceField(values, fieldName);
  });

  return {
    id: resolveMakeId(opts)(),
    name,
    kind: "xlsx",
    fields,
    rowCount,
  };
}
