import type { Schema } from "@schema-studio/core";

export function tableNameFromFilename(filename: string): string {
  const base = filename.replace(/\.[^.]+$/, "");
  const sanitized = base
    .trim()
    .replace(/[^a-zA-Z0-9_]+/g, "_")
    .replace(/^_+|_+$/g, "");

  if (!sanitized) {
    return "table";
  }

  if (/^\d/.test(sanitized)) {
    return `_${sanitized}`;
  }

  return sanitized;
}

function tableNameExists(schema: Schema, name: string): boolean {
  const lower = name.toLowerCase();
  return schema.tables.some((table) => table.name.toLowerCase() === lower);
}

export function uniqueTableName(schema: Schema, base: string): string {
  if (!tableNameExists(schema, base)) {
    return base;
  }

  let index = 2;
  while (tableNameExists(schema, `${base}_${index}`)) {
    index += 1;
  }

  return `${base}_${index}`;
}
