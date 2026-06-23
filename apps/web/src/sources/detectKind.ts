import type { SourceKind } from "@schema-studio/core";

export function detectSourceKind(filename: string): SourceKind | null {
  const lower = filename.toLowerCase();

  if (lower.endsWith(".csv") || lower.endsWith(".tsv")) {
    return "csv";
  }

  if (lower.endsWith(".xlsx") || lower.endsWith(".xls")) {
    return "xlsx";
  }

  if (lower.endsWith(".json")) {
    return "json";
  }

  return null;
}
