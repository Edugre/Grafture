import Papa from "papaparse";
import * as XLSX from "xlsx";

export type ParsedSource = {
  name: string;
  columns: string[];
  rows: Record<string, unknown>[];
};

export function parseCsv(content: string, name: string): ParsedSource {
  const result = Papa.parse<Record<string, unknown>>(content, {
    header: true,
    skipEmptyLines: true,
  });

  const columns = result.meta.fields ?? [];

  return {
    name,
    columns,
    rows: result.data,
  };
}

export function parseXlsx(buffer: ArrayBuffer, name: string): ParsedSource {
  const workbook = XLSX.read(buffer, { type: "array" });
  const firstSheetName = workbook.SheetNames[0];

  if (!firstSheetName) {
    return { name, columns: [], rows: [] };
  }

  const sheet = workbook.Sheets[firstSheetName];

  if (!sheet) {
    return { name, columns: [], rows: [] };
  }

  const rows = XLSX.utils.sheet_to_json<Record<string, unknown>>(sheet);
  const columns = rows[0] ? Object.keys(rows[0]) : [];

  return { name, columns, rows };
}

export function parseJson(content: string, name: string): ParsedSource {
  const parsed: unknown = JSON.parse(content);

  if (Array.isArray(parsed)) {
    const rows = parsed.filter(
      (row): row is Record<string, unknown> => typeof row === "object" && row !== null,
    );
    const columns = rows[0] ? Object.keys(rows[0]) : [];

    return { name, columns, rows };
  }

  if (typeof parsed === "object" && parsed !== null) {
    const rows = [parsed as Record<string, unknown>];
    return { name, columns: Object.keys(parsed as Record<string, unknown>), rows };
  }

  return { name, columns: [], rows: [] };
}
