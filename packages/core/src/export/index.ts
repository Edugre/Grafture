import type { Cardinality, Field, Schema, Table } from "../model.js";

/**
 * Exporters turn a {@link Schema} into real, deterministic code so users can leave
 * with a migration rather than a picture. Output ordering follows the schema's own
 * table/field/relationship arrays — same input always yields the same string, which
 * keeps tests clean and diffs reviewable.
 */

type ResolvedRelationship = {
  fromTable: Table;
  fromField: Field;
  toTable: Table;
  toField: Field;
  cardinality: Cardinality;
};

/**
 * Relationships reference tables and fields by id; resolve them to the actual
 * records once so every exporter works with names. Dangling relationships (a missing
 * table or field) are skipped rather than emitting broken output.
 */
function resolveRelationships(schema: Schema): ResolvedRelationship[] {
  const tableById = new Map(schema.tables.map((table) => [table.id, table]));
  const resolved: ResolvedRelationship[] = [];

  for (const relationship of schema.relationships) {
    const fromTable = tableById.get(relationship.fromTable);
    const toTable = tableById.get(relationship.toTable);
    if (!fromTable || !toTable) {
      continue;
    }

    const fromField = fromTable.fields.find((field) => field.id === relationship.fromField);
    const toField = toTable.fields.find((field) => field.id === relationship.toField);
    if (!fromField || !toField) {
      continue;
    }

    resolved.push({
      fromTable,
      fromField,
      toTable,
      toField,
      cardinality: relationship.cardinality,
    });
  }

  return resolved;
}

// Field names come verbatim from source headers ("Grant Number", "Amount ($)"), so every
// exporter has to make them valid identifiers in its own syntax rather than emitting them raw.

const PLAIN_IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;

// --- DBML -----------------------------------------------------------------

/** DBML identifier: bare when plain, double-quoted otherwise (quotes have no escape in DBML). */
function dbmlIdent(name: string): string {
  return PLAIN_IDENT.test(name) ? name : `"${name.replace(/"/g, "'")}"`;
}

function dbmlRefTarget(table: Table, field: Field): string {
  return `${dbmlIdent(table.name)}.${dbmlIdent(field.name)}`;
}

const DBML_REF_OP: Record<Cardinality, string> = {
  "1:1": "-",
  "1:N": ">",
  "N:M": "<>",
};

export function toDbml(schema: Schema): string {
  const relationships = resolveRelationships(schema);

  // One inline ref per field (DBML allows a single `ref:` attribute per column);
  // any further relationships on the same field fall back to standalone `Ref:` lines
  // so nothing is silently dropped.
  const inlineByFieldId = new Map<string, ResolvedRelationship>();
  for (const relationship of relationships) {
    if (!inlineByFieldId.has(relationship.fromField.id)) {
      inlineByFieldId.set(relationship.fromField.id, relationship);
    }
  }

  const tableBlocks = schema.tables.map((table) => {
    const fieldLines = table.fields.map((field) => {
      const attributes: string[] = [];
      if (field.pk) {
        attributes.push("pk");
      }

      const inlineRef = inlineByFieldId.get(field.id);
      if (inlineRef) {
        attributes.push(
          `ref: ${DBML_REF_OP[inlineRef.cardinality]} ${dbmlRefTarget(inlineRef.toTable, inlineRef.toField)}`,
        );
      }

      const suffix = attributes.length > 0 ? ` [${attributes.join(", ")}]` : "";
      return `  ${dbmlIdent(field.name)} ${field.type}${suffix}`;
    });

    return `Table ${dbmlIdent(table.name)} {\n${fieldLines.join("\n")}\n}`;
  });

  const extraRefLines = relationships
    .filter((relationship) => inlineByFieldId.get(relationship.fromField.id) !== relationship)
    .map(
      (relationship) =>
        `Ref: ${dbmlRefTarget(relationship.fromTable, relationship.fromField)} ` +
        `${DBML_REF_OP[relationship.cardinality]} ` +
        `${dbmlRefTarget(relationship.toTable, relationship.toField)}`,
    );

  return [...tableBlocks, ...extraRefLines].join("\n\n");
}

// --- SQL (Postgres) -------------------------------------------------------

export type SqlDialect = "postgres";

const POSTGRES_TYPES: Record<string, string> = {
  int: "integer",
  numeric: "numeric",
  bool: "boolean",
  date: "date",
  timestamp: "timestamptz",
  text: "text",
};

function postgresType(type: string): string {
  return POSTGRES_TYPES[type] ?? type;
}

function quoteIdent(name: string): string {
  return `"${name.replace(/"/g, '""')}"`;
}

/**
 * Column types that only exist behind a Postgres extension, keyed by the type's base name
 * (lowercased, parameters stripped). When the schema uses one, the DDL must create the
 * extension first or the CREATE TABLE fails — this keeps the copilot's extension-type
 * suggestions (PostGIS, citext) honest through `preview_export`.
 */
const POSTGRES_EXTENSION_BY_TYPE: Record<string, string> = {
  geography: "postgis",
  geometry: "postgis",
  citext: "citext",
};

function requiredExtensions(schema: Schema): string[] {
  const extensions = new Set<string>();
  for (const table of schema.tables) {
    for (const field of table.fields) {
      const baseType = postgresType(field.type).toLowerCase().split("(")[0]?.trim() ?? "";
      const extension = POSTGRES_EXTENSION_BY_TYPE[baseType];
      if (extension) {
        extensions.add(extension);
      }
    }
  }
  return [...extensions].sort();
}

export function toSql(schema: Schema, dialect: SqlDialect = "postgres"): string {
  void dialect; // Postgres is the only supported dialect for now.
  const relationships = resolveRelationships(schema);
  const statements: string[] = [];

  for (const extension of requiredExtensions(schema)) {
    statements.push(`CREATE EXTENSION IF NOT EXISTS ${extension};`);
  }

  for (const table of schema.tables) {
    const pkFields = table.fields.filter((field) => field.pk);
    const singlePk = pkFields.length === 1;

    const lines = table.fields.map((field) => {
      const inlinePk = singlePk && field.pk ? " PRIMARY KEY" : "";
      return `  ${quoteIdent(field.name)} ${postgresType(field.type)}${inlinePk}`;
    });

    if (pkFields.length > 1) {
      lines.push(`  PRIMARY KEY (${pkFields.map((field) => quoteIdent(field.name)).join(", ")})`);
    }

    statements.push(`CREATE TABLE ${quoteIdent(table.name)} (\n${lines.join(",\n")}\n);`);
  }

  for (const relationship of relationships) {
    const constraint = `${relationship.fromTable.name}_${relationship.fromField.name}_fkey`;
    statements.push(
      `ALTER TABLE ${quoteIdent(relationship.fromTable.name)} ` +
        `ADD CONSTRAINT ${quoteIdent(constraint)} ` +
        `FOREIGN KEY (${quoteIdent(relationship.fromField.name)}) ` +
        `REFERENCES ${quoteIdent(relationship.toTable.name)} (${quoteIdent(relationship.toField.name)});`,
    );
  }

  return statements.join("\n\n");
}

// --- Prisma ---------------------------------------------------------------

const PRISMA_TYPES: Record<string, string> = {
  int: "Int",
  numeric: "Decimal",
  bool: "Boolean",
  date: "DateTime",
  timestamp: "DateTime",
  text: "String",
};

function prismaType(type: string): string {
  // Prisma requires a known scalar; fall back to String for unrecognised types.
  return PRISMA_TYPES[type] ?? "String";
}

/** A legal Prisma identifier derived from a raw name: [A-Za-z][A-Za-z0-9_]*. */
function prismaIdent(raw: string): string {
  const cleaned = raw.replace(/[^A-Za-z0-9_]/g, "_");
  return /^[A-Za-z]/.test(cleaned) ? cleaned : `x${cleaned ? `_${cleaned}` : ""}`;
}

/**
 * Sanitize a list of raw names into unique Prisma identifiers, in order. Distinct raw names
 * can sanitize to the same identifier ("a b" and "a-b" → "a_b"), so collisions get `_2`, `_3`…
 */
function uniquePrismaNames(rawNames: string[]): string[] {
  const used = new Set<string>();
  return rawNames.map((raw) => {
    const base = prismaIdent(raw);
    let candidate = base;
    let suffix = 2;
    while (used.has(candidate)) {
      candidate = `${base}_${suffix}`;
      suffix += 1;
    }
    used.add(candidate);
    return candidate;
  });
}

function prismaMapLiteral(raw: string): string {
  return `"${raw.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

export function toPrisma(schema: Schema): string {
  const relationships = resolveRelationships(schema);

  // Prisma has no quoted identifiers, so raw names (CSV headers like "Grant Number") are
  // sanitized into legal model/field names and mapped back with @map/@@map.
  const modelNames = uniquePrismaNames(schema.tables.map((table) => table.name));
  const modelNameByTableId = new Map<string, string>(
    schema.tables.map((table, index) => [table.id, modelNames[index] ?? table.name]),
  );
  const fieldNameById = new Map<string, string>();
  for (const table of schema.tables) {
    const names = uniquePrismaNames(table.fields.map((field) => field.name));
    table.fields.forEach((field, index) => {
      fieldNameById.set(field.id, names[index] ?? field.name);
    });
  }
  const modelName = (table: Table): string => modelNameByTableId.get(table.id) ?? table.name;
  const fieldName = (field: Field): string => fieldNameById.get(field.id) ?? field.name;

  const models = schema.tables.map((table) => {
    const pkFields = table.fields.filter((field) => field.pk);
    const singlePk = pkFields.length === 1;

    const lines = table.fields.map((field) => {
      const name = fieldName(field);
      const attributes = [
        singlePk && field.pk ? " @id" : "",
        name !== field.name ? ` @map(${prismaMapLiteral(field.name)})` : "",
      ].join("");
      return `  ${name} ${prismaType(field.type)}${attributes}`;
    });

    // Owning side: the table holds the foreign-key scalar.
    for (const relationship of relationships) {
      if (relationship.fromTable.id !== table.id) {
        continue;
      }
      const target = modelName(relationship.toTable);
      if (relationship.cardinality === "N:M") {
        lines.push(`  ${target} ${target}[]`);
      } else {
        lines.push(
          `  ${target} ${target} ` +
            `@relation(fields: [${fieldName(relationship.fromField)}], references: [${fieldName(relationship.toField)}])`,
        );
      }
    }

    // Back-reference side.
    for (const relationship of relationships) {
      if (relationship.toTable.id !== table.id) {
        continue;
      }
      const source = modelName(relationship.fromTable);
      const modifier = relationship.cardinality === "1:1" ? "?" : "[]";
      lines.push(`  ${source} ${source}${modifier}`);
    }

    if (pkFields.length > 1) {
      lines.push(`  @@id([${pkFields.map(fieldName).join(", ")}])`);
    }

    const name = modelName(table);
    if (name !== table.name) {
      lines.push(`  @@map(${prismaMapLiteral(table.name)})`);
    }

    return `model ${name} {\n${lines.join("\n")}\n}`;
  });

  return models.join("\n\n");
}
