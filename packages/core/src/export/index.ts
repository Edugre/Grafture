import type { Schema } from "../model.js";

export function toDbml(schema: Schema): string {
  void schema;
  return "// DBML export not implemented yet";
}

export function toSql(schema: Schema): string {
  void schema;
  return "-- SQL export not implemented yet";
}

export function toPrisma(schema: Schema): string {
  void schema;
  return "// Prisma export not implemented yet";
}
