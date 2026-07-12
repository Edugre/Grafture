import Papa from "papaparse";

import type { Source } from "./types.js";
import { buildSourceField, dedupeNames, resolveMakeId, type ParseOptions } from "./util.js";
import { MAX_ROW_TUPLES, MAX_SCAN_ROWS, collectJoinValues, sampleScanRows } from "./sample.js";

export function parseCsv(input: string, name: string, opts?: ParseOptions): Source {
  const result = Papa.parse<string[]>(input, {
    header: false,
    skipEmptyLines: true,
  });

  const rows = result.data;
  if (rows.length === 0) {
    return {
      id: resolveMakeId(opts)(),
      name,
      kind: "csv",
      fields: [],
      rowCount: 0,
    };
  }

  const headerRow = rows[0] ?? [];
  const rawNames = headerRow.map((cell, index) => {
    const trimmed = cell.trim();
    return trimmed === "" ? `column_${index + 1}` : trimmed;
  });
  const fieldNames = dedupeNames(rawNames);
  const allDataRows = rows.slice(1);
  const dataRows = sampleScanRows(allDataRows);
  // Wide join-discovery pass: only when the scan window actually narrowed the file. The row
  // tuples are transient — only each column's distinct Set survives (see collectJoinValues).
  const needWidePass = allDataRows.length > MAX_SCAN_ROWS;

  const fields = fieldNames.map((fieldName, columnIndex) => {
    const columnValues = dataRows.map((row) => row[columnIndex] ?? "");
    const joinValues = needWidePass
      ? collectJoinValues(allDataRows.map((row) => row[columnIndex] ?? ""))
      : undefined;
    return buildSourceField(columnValues, fieldName, joinValues);
  });

  const sampleRows = sampleScanRows(dataRows, MAX_ROW_TUPLES).map((row) =>
    fieldNames.map((_, columnIndex) => row[columnIndex] ?? ""),
  );

  return {
    id: resolveMakeId(opts)(),
    name,
    kind: "csv",
    fields,
    sampleRows,
    // Full data-row count (header excluded), uncapped — not limited to the scanned slice.
    rowCount: rows.length - 1,
  };
}
