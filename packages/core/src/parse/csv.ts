import Papa from "papaparse";

import type { Source } from "./types.js";
import { buildSourceField, dedupeNames, resolveMakeId, type ParseOptions } from "./util.js";
import { sampleScanRows } from "./sample.js";

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
  const dataRows = sampleScanRows(rows.slice(1));

  const fields = fieldNames.map((fieldName, columnIndex) => {
    const columnValues = dataRows.map((row) => row[columnIndex] ?? "");
    return buildSourceField(columnValues, fieldName);
  });

  return {
    id: resolveMakeId(opts)(),
    name,
    kind: "csv",
    fields,
    // Full data-row count (header excluded), uncapped — not limited to the scanned slice.
    rowCount: rows.length - 1,
  };
}
