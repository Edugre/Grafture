import { SchemaSchema } from "../model.js";
import type { Cardinality, Field, Relationship, Schema, Table } from "../model.js";
import { ParseError } from "../parse/errors.js";

/**
 * `fromSql` is the inverse of {@link toSql}: it reads PostgreSQL DDL and produces a {@link Schema}
 * the canvas can open. It is deliberately a focused DDL reader, not a full SQL parser — its
 * guaranteed contract is round-tripping the subset {@link toSql} emits (CREATE TABLE with inline or
 * composite PRIMARY KEY, inline REFERENCES, and standalone ALTER TABLE ... ADD FOREIGN KEY), plus
 * the common shapes of hand-written schema files.
 *
 * Supported: CREATE TABLE (IF NOT EXISTS, schema-qualified and quoted names), column definitions
 * with inline PRIMARY KEY / REFERENCES, table-level PRIMARY KEY / FOREIGN KEY constraints, and
 * ALTER TABLE ADD [CONSTRAINT] PRIMARY KEY / FOREIGN KEY. Line and block comments are stripped.
 * Keywords are case-insensitive.
 *
 * Anything else (CREATE INDEX / VIEW, INSERT, functions, …) is skipped and reported in
 * `warnings` rather than failing the import; a dangling foreign key (referencing an unknown table
 * or column) is likewise skipped with a warning. Only a total failure — no CREATE TABLE at all —
 * throws {@link ParseError}.
 *
 * Types are normalized to the canvas's canonical vocabulary where a synonym is recognized
 * (`int4` → `integer`, `bool` → `boolean`, `timestamptz` → `timestamptz`, …) and passed through
 * verbatim otherwise, so `uuid`, `jsonb`, and parameterized types like `varchar(255)` or
 * `geography(Point, 4326)` survive a round-trip.
 *
 * The importer carries no geometry, so tables are laid out on a deterministic grid; re-run the
 * app's auto-layout after import for a nicer arrangement. Pure and framework-free — same as the
 * exporters it mirrors.
 */

export type FromSqlOptions = {
  /** Injectable id factory, for deterministic tests. Defaults to `crypto.randomUUID`. */
  makeId?: () => string;
};

export type FromSqlResult = {
  schema: Schema;
  /**
   * Statements or columns that were recognized but not fully modeled — skipped unsupported
   * statements and dropped foreign keys. Empty on a clean import.
   */
  warnings: string[];
};

const GRID_COLUMNS = 4;
const GRID_SPACING_X = 280;
const GRID_SPACING_Y = 200;
const DEFAULT_CARDINALITY: Cardinality = "1:N";

// --- type vocabulary ------------------------------------------------------

/**
 * Parameterless SQL type synonyms mapped to the canvas's canonical types (the `postgres` target
 * profile vocabulary). Parameterized types (`varchar(255)`, `numeric(10,2)`) and anything not
 * listed here are preserved verbatim so the schema round-trips through {@link toSql}.
 */
const TYPE_SYNONYMS: Record<string, string> = {
  int: "integer",
  int2: "integer",
  int4: "integer",
  int8: "integer",
  integer: "integer",
  smallint: "integer",
  bigint: "integer",
  serial: "integer",
  serial2: "integer",
  serial4: "integer",
  serial8: "integer",
  smallserial: "integer",
  bigserial: "integer",
  numeric: "numeric",
  decimal: "numeric",
  real: "numeric",
  money: "numeric",
  float: "numeric",
  float4: "numeric",
  float8: "numeric",
  double: "numeric",
  "double precision": "numeric",
  bool: "boolean",
  boolean: "boolean",
  date: "date",
  timestamp: "timestamptz",
  timestamptz: "timestamptz",
  "timestamp with time zone": "timestamptz",
  "timestamp without time zone": "timestamptz",
  text: "text",
  varchar: "text",
  "character varying": "text",
  char: "text",
  character: "text",
  bpchar: "text",
};

/** Collapse a raw type to canonical form, preserving parameters and unknown types verbatim. */
function normalizeType(raw: string): string {
  const trimmed = raw.trim().replace(/\s+/g, " ");
  const parenIndex = trimmed.indexOf("(");
  if (parenIndex >= 0) {
    // Parameterized — keep the parameters (lowercasing only the base name for stability).
    const base = trimmed.slice(0, parenIndex).trim().toLowerCase();
    return `${base}${trimmed.slice(parenIndex)}`;
  }
  const lower = trimmed.toLowerCase();
  return TYPE_SYNONYMS[lower] ?? lower;
}

// --- low-level scanning helpers -------------------------------------------

/** Read a balanced `(...)` group starting at `text[start]`; returns the inner text and `)` index. */
function readBalancedParens(text: string, start: number): { inner: string; end: number } | null {
  if (text[start] !== "(") {
    return null;
  }
  let depth = 0;
  let inString: string | null = null;
  for (let i = start; i < text.length; i++) {
    const ch = text[i]!;
    if (inString) {
      if (ch === inString) {
        if (text[i + 1] === inString) {
          i++;
          continue;
        }
        inString = null;
      }
      continue;
    }
    if (ch === "'" || ch === '"') {
      inString = ch;
      continue;
    }
    if (ch === "(") {
      depth++;
    } else if (ch === ")") {
      depth--;
      if (depth === 0) {
        return { inner: text.slice(start + 1, i), end: i };
      }
    }
  }
  return null;
}

/** Split on `separator` at paren depth 0, ignoring separators inside quotes; trims and drops empties. */
function splitTopLevel(text: string, separator = ","): string[] {
  const parts: string[] = [];
  let depth = 0;
  let inString: string | null = null;
  let current = "";
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (inString) {
      current += ch;
      if (ch === inString) {
        if (text[i + 1] === inString) {
          current += text[++i];
          continue;
        }
        inString = null;
      }
      continue;
    }
    if (ch === "'" || ch === '"') {
      inString = ch;
      current += ch;
      continue;
    }
    if (ch === "(") {
      depth++;
    } else if (ch === ")") {
      depth--;
    } else if (ch === separator && depth === 0) {
      parts.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  parts.push(current);
  return parts.map((part) => part.trim()).filter((part) => part.length > 0);
}

/** Read a single identifier (bare or `"quoted"`) at/after `pos`, skipping leading whitespace. */
function readIdentifier(text: string, pos: number): { name: string; next: number } | null {
  let i = pos;
  while (i < text.length && /\s/.test(text[i]!)) {
    i++;
  }
  if (i >= text.length) {
    return null;
  }
  if (text[i] === '"') {
    let name = "";
    i++;
    while (i < text.length) {
      const ch = text[i]!;
      if (ch === '"') {
        if (text[i + 1] === '"') {
          name += '"';
          i += 2;
          continue;
        }
        return { name, next: i + 1 };
      }
      name += ch;
      i++;
    }
    return null; // unterminated quote
  }
  const match = /^[A-Za-z_][A-Za-z0-9_$]*/.exec(text.slice(i));
  if (!match) {
    return null;
  }
  return { name: match[0], next: i + match[0].length };
}

/** Read a possibly schema-qualified name (`schema.table`), returning the final (rightmost) segment. */
function readQualifiedName(text: string, pos: number): { name: string; next: number } | null {
  const first = readIdentifier(text, pos);
  if (!first) {
    return null;
  }
  let name = first.name;
  let next = first.next;
  for (;;) {
    let j = next;
    while (j < text.length && /\s/.test(text[j]!)) {
      j++;
    }
    if (text[j] !== ".") {
      break;
    }
    const segment = readIdentifier(text, j + 1);
    if (!segment) {
      break;
    }
    name = segment.name;
    next = segment.next;
  }
  return { name, next };
}

/** Read a parenthesized comma-separated column list at/after `pos`. */
function readColumnList(text: string, pos: number): { columns: string[]; next: number } | null {
  let i = pos;
  while (i < text.length && /\s/.test(text[i]!)) {
    i++;
  }
  if (text[i] !== "(") {
    return null;
  }
  const parens = readBalancedParens(text, i);
  if (!parens) {
    return null;
  }
  const columns: string[] = [];
  for (const raw of splitTopLevel(parens.inner, ",")) {
    const id = readIdentifier(raw, 0);
    if (id) {
      columns.push(id.name);
    }
  }
  return { columns, next: parens.end + 1 };
}

/** Type-definition boundary keywords: the type is every token before the first of these. */
const TYPE_STOP_WORDS = new Set([
  "NOT",
  "NULL",
  "DEFAULT",
  "PRIMARY",
  "REFERENCES",
  "UNIQUE",
  "CHECK",
  "CONSTRAINT",
  "GENERATED",
  "COLLATE",
  "DEFERRABLE",
  "COMMENT",
]);

/** Read a (possibly multi-word, possibly parameterized) column type at/after `pos`. */
function readType(text: string, pos: number): { type: string; next: number } | null {
  let i = pos;
  const parts: string[] = [];
  for (;;) {
    while (i < text.length && /\s/.test(text[i]!)) {
      i++;
    }
    if (i >= text.length) {
      break;
    }
    if (text[i] === "(") {
      const parens = readBalancedParens(text, i);
      if (!parens || parts.length === 0) {
        break;
      }
      parts[parts.length - 1] += `(${parens.inner})`;
      i = parens.end + 1;
      continue;
    }
    const word = /^[A-Za-z_][A-Za-z0-9_]*/.exec(text.slice(i));
    if (!word) {
      break;
    }
    if (parts.length > 0 && TYPE_STOP_WORDS.has(word[0].toUpperCase())) {
      break;
    }
    parts.push(word[0]);
    i += word[0].length;
  }
  if (parts.length === 0) {
    return null;
  }
  return { type: parts.join(" "), next: i };
}

// --- statement model ------------------------------------------------------

type RawColumn = { name: string; type: string; pk: boolean };
type RawForeignKey = { fromColumns: string[]; toTable: string; toColumns: string[] };
type RawTable = {
  name: string;
  columns: RawColumn[];
  pkColumns: string[];
  foreignKeys: RawForeignKey[];
};

type ParseContext = {
  tables: RawTable[];
  alterForeignKeys: (RawForeignKey & { fromTable: string })[];
  primaryKeyAlters: { table: string; columns: string[] }[];
  warnings: string[];
};

/** A short, single-line preview of a statement for a "skipped" warning. */
function preview(statement: string): string {
  const collapsed = statement.replace(/\s+/g, " ").trim();
  return collapsed.length > 60 ? `${collapsed.slice(0, 60)}…` : collapsed;
}

/** Matches a Postgres dollar-quote opener (`$$` or `$tag$`) at the start of a string. */
const DOLLAR_QUOTE_OPEN = /^\$([A-Za-z_][A-Za-z0-9_]*)?\$/;

/**
 * Split a SQL script into statements on top-level `;`, stripping line and block comments and
 * respecting string/quoted-identifier literals and dollar-quoted bodies (`$$ … $$`, `$tag$ … $tag$`)
 * — so a `CREATE FUNCTION` body's internal semicolons don't split it into fragments.
 */
function splitStatements(sql: string): string[] {
  const statements: string[] = [];
  let current = "";
  let inString: string | null = null;
  let inLineComment = false;
  let inBlockComment = false;
  let dollarTag: string | null = null;
  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i]!;
    const next = sql[i + 1];
    if (inLineComment) {
      if (ch === "\n") {
        inLineComment = false;
        current += ch;
      }
      continue;
    }
    if (inBlockComment) {
      if (ch === "*" && next === "/") {
        inBlockComment = false;
        current += " ";
        i++;
      }
      continue;
    }
    if (inString) {
      current += ch;
      if (ch === inString) {
        if (next === inString) {
          current += next;
          i++;
          continue;
        }
        inString = null;
      }
      continue;
    }
    if (dollarTag) {
      // Everything up to the matching close tag is a literal body — semicolons and quotes inside
      // are inert.
      if (sql.startsWith(dollarTag, i)) {
        current += dollarTag;
        i += dollarTag.length - 1;
        dollarTag = null;
      } else {
        current += ch;
      }
      continue;
    }
    if (ch === "-" && next === "-") {
      inLineComment = true;
      i++;
      continue;
    }
    if (ch === "/" && next === "*") {
      inBlockComment = true;
      i++;
      continue;
    }
    if (ch === "$") {
      const open = DOLLAR_QUOTE_OPEN.exec(sql.slice(i));
      if (open) {
        dollarTag = open[0];
        current += open[0];
        i += open[0].length - 1;
        continue;
      }
    }
    if (ch === "'" || ch === '"') {
      inString = ch;
      current += ch;
      continue;
    }
    if (ch === ";") {
      statements.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  statements.push(current);
  return statements
    .map((statement) => statement.trim())
    .filter((statement) => statement.length > 0);
}

/** Session/DDL statements that carry no schema structure — skipped silently, no warning. */
const SILENTLY_SKIPPED =
  /^(set|create\s+extension|create\s+schema|create\s+sequence|create\s+type|comment\s+on|begin|commit|start\s+transaction|drop\b|grant\b|revoke\b)\b/i;

const CREATE_TABLE_HEAD =
  /^create\s+(?:global\s+|local\s+|temp\s+|temporary\s+|unlogged\s+)*table\s+(?:if\s+not\s+exists\s+)?/i;

/**
 * Blank out (with spaces, preserving indices) every character inside a string literal or a
 * parenthesized group. Used before scanning a column's modifier tail for `PRIMARY KEY` / `REFERENCES`
 * so those keywords appearing inside a `CHECK (...)` expression or a `DEFAULT '...'` literal aren't
 * mistaken for real constraints. The real inline keywords sit outside any parens/quotes, so they
 * survive the mask; positions still line up with the original text for follow-on parsing.
 */
function maskModifiers(text: string): string {
  const out = text.split("");
  let inString: string | null = null;
  let depth = 0;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (inString) {
      out[i] = " ";
      if (ch === inString) {
        if (text[i + 1] === inString) {
          out[i + 1] = " ";
          i++;
          continue;
        }
        inString = null;
      }
      continue;
    }
    if (ch === "'" || ch === '"') {
      inString = ch;
      out[i] = " ";
      continue;
    }
    if (ch === "(") {
      depth++;
      out[i] = " ";
      continue;
    }
    if (ch === ")") {
      if (depth > 0) {
        depth--;
      }
      out[i] = " ";
      continue;
    }
    if (depth > 0) {
      out[i] = " ";
    }
  }
  return out.join("");
}

/** Parse `REFERENCES table [(columns)]` starting at `pos`, given the referencing columns. */
function parseReferences(text: string, pos: number, fromColumns: string[]): RawForeignKey | null {
  const tableRead = readQualifiedName(text, pos);
  if (!tableRead) {
    return null;
  }
  const columns = readColumnList(text, tableRead.next);
  return { fromColumns, toTable: tableRead.name, toColumns: columns ? columns.columns : [] };
}

/** Parse `(columns) REFERENCES table [(columns)]` (the tail of a FOREIGN KEY clause). */
function parseForeignKeyClause(text: string): RawForeignKey | null {
  const columns = readColumnList(text, 0);
  if (!columns) {
    return null;
  }
  const refMatch = /\breferences\b/i.exec(text.slice(columns.next));
  if (!refMatch) {
    return null;
  }
  return parseReferences(text, columns.next + refMatch.index + refMatch[0].length, columns.columns);
}

/** Parse one item from a CREATE TABLE body: a column definition or a table-level constraint. */
function parseTableItem(item: string, table: RawTable): void {
  let s = item.trim();
  const constraintPrefix = /^constraint\s+/i.exec(s);
  if (constraintPrefix) {
    const after = readIdentifier(s, constraintPrefix[0].length);
    if (after) {
      s = s.slice(after.next).trim();
    }
  }

  if (/^primary\s+key\b/i.test(s)) {
    const cols = readColumnList(s.replace(/^primary\s+key\b/i, ""), 0);
    if (cols) {
      table.pkColumns.push(...cols.columns);
    }
    return;
  }

  if (/^foreign\s+key\b/i.test(s)) {
    const fk = parseForeignKeyClause(s.replace(/^foreign\s+key\b/i, ""));
    if (fk) {
      table.foreignKeys.push(fk);
    }
    return;
  }

  // Other table-level constraints carry no structure we model.
  if (/^(unique|check|exclude|like|primary)\b/i.test(s)) {
    return;
  }

  // Column definition: name, type, then modifiers.
  const nameRead = readIdentifier(s, 0);
  if (!nameRead) {
    return;
  }
  const typeRead = readType(s, nameRead.next);
  if (!typeRead) {
    return;
  }
  const modifiers = s.slice(typeRead.next);
  // Scan a masked copy so PRIMARY KEY / REFERENCES inside a CHECK (...) or DEFAULT '...' aren't
  // misread as real constraints; indices still map back to `modifiers` for follow-on parsing.
  const masked = maskModifiers(modifiers);
  table.columns.push({
    name: nameRead.name,
    type: normalizeType(typeRead.type),
    pk: /\bprimary\s+key\b/i.test(masked),
  });

  const refMatch = /\breferences\b/i.exec(masked);
  if (refMatch) {
    const fk = parseReferences(modifiers, refMatch.index + refMatch[0].length, [nameRead.name]);
    if (fk) {
      table.foreignKeys.push(fk);
    }
  }
}

function parseCreateTable(statement: string, ctx: ParseContext): void {
  const head = CREATE_TABLE_HEAD.exec(statement);
  if (!head) {
    ctx.warnings.push(`Skipped unsupported statement: ${preview(statement)}`);
    return;
  }
  const nameRead = readQualifiedName(statement, head[0].length);
  if (!nameRead) {
    ctx.warnings.push(`Skipped unsupported statement: ${preview(statement)}`);
    return;
  }
  let open = nameRead.next;
  while (open < statement.length && statement[open] !== "(") {
    open++;
  }
  const body = readBalancedParens(statement, open);
  if (!body) {
    ctx.warnings.push(`Skipped unsupported statement: ${preview(statement)}`);
    return;
  }
  const table: RawTable = { name: nameRead.name, columns: [], pkColumns: [], foreignKeys: [] };
  for (const item of splitTopLevel(body.inner, ",")) {
    parseTableItem(item, table);
  }
  ctx.tables.push(table);
}

function parseAlterTable(statement: string, ctx: ParseContext): void {
  const head = /^alter\s+table\s+(?:only\s+)?(?:if\s+exists\s+)?/i.exec(statement);
  if (!head) {
    ctx.warnings.push(`Skipped unsupported statement: ${preview(statement)}`);
    return;
  }
  const nameRead = readQualifiedName(statement, head[0].length);
  if (!nameRead) {
    ctx.warnings.push(`Skipped unsupported statement: ${preview(statement)}`);
    return;
  }
  const addMatch = /\badd\b/i.exec(statement.slice(nameRead.next));
  if (!addMatch) {
    ctx.warnings.push(`Skipped unsupported statement: ${preview(statement)}`);
    return;
  }
  let rest = statement.slice(nameRead.next + addMatch.index + addMatch[0].length);
  const constraintPrefix = /^\s*constraint\s+/i.exec(rest);
  if (constraintPrefix) {
    const after = readIdentifier(rest, constraintPrefix[0].length);
    if (after) {
      rest = rest.slice(after.next);
    }
  }

  if (/^\s*foreign\s+key\b/i.test(rest)) {
    const fk = parseForeignKeyClause(rest.replace(/^\s*foreign\s+key\b/i, ""));
    if (fk) {
      ctx.alterForeignKeys.push({ fromTable: nameRead.name, ...fk });
    } else {
      ctx.warnings.push(`Skipped unsupported statement: ${preview(statement)}`);
    }
    return;
  }

  if (/^\s*primary\s+key\b/i.test(rest)) {
    const cols = readColumnList(rest.replace(/^\s*primary\s+key\b/i, ""), 0);
    if (cols) {
      ctx.primaryKeyAlters.push({ table: nameRead.name, columns: cols.columns });
    }
    return;
  }

  ctx.warnings.push(`Skipped unsupported statement: ${preview(statement)}`);
}

function dispatch(statement: string, ctx: ParseContext): void {
  if (CREATE_TABLE_HEAD.test(statement)) {
    parseCreateTable(statement, ctx);
    return;
  }
  if (/^alter\s+table\b/i.test(statement)) {
    parseAlterTable(statement, ctx);
    return;
  }
  if (SILENTLY_SKIPPED.test(statement)) {
    return;
  }
  ctx.warnings.push(`Skipped unsupported statement: ${preview(statement)}`);
}

// --- assembly -------------------------------------------------------------

/** Case-insensitive name lookup: exact match wins, then a lowercased fallback. */
function makeLookup<T>(entries: [string, T][]): (name: string) => T | undefined {
  const exact = new Map<string, T>();
  const lower = new Map<string, T>();
  for (const [name, value] of entries) {
    if (!exact.has(name)) {
      exact.set(name, value);
    }
    const key = name.toLowerCase();
    if (!lower.has(key)) {
      lower.set(key, value);
    }
  }
  return (name) => exact.get(name) ?? lower.get(name.toLowerCase());
}

function buildSchema(ctx: ParseContext, makeId: () => string): Schema {
  // Fold ALTER ... ADD PRIMARY KEY back into the owning table's pk columns.
  const findRaw = makeLookup(ctx.tables.map((table) => [table.name, table] as [string, RawTable]));
  for (const alter of ctx.primaryKeyAlters) {
    const raw = findRaw(alter.table);
    if (raw) {
      raw.pkColumns.push(...alter.columns);
    }
  }

  const tables: Table[] = ctx.tables.map((raw, index) => {
    const pkNames = new Set(raw.pkColumns.map((name) => name.toLowerCase()));
    const fields: Field[] = raw.columns.map((column) => ({
      id: makeId(),
      name: column.name,
      type: column.type,
      pk: column.pk || pkNames.has(column.name.toLowerCase()),
      fk: false,
    }));
    return {
      id: makeId(),
      name: raw.name,
      x: (index % GRID_COLUMNS) * GRID_SPACING_X,
      y: Math.floor(index / GRID_COLUMNS) * GRID_SPACING_Y,
      fields,
    };
  });

  const findTable = makeLookup(tables.map((table) => [table.name, table] as [string, Table]));
  const fieldFinders = new Map<string, (name: string) => Field | undefined>();
  for (const table of tables) {
    fieldFinders.set(
      table.id,
      makeLookup(table.fields.map((field) => [field.name, field] as [string, Field])),
    );
  }

  // Every foreign key, whether inline, table-level, or from an ALTER, resolved uniformly.
  const allForeignKeys = [
    ...ctx.tables.flatMap((raw) => raw.foreignKeys.map((fk) => ({ fromTable: raw.name, ...fk }))),
    ...ctx.alterForeignKeys,
  ];

  const relationships: Relationship[] = [];
  const seen = new Set<string>();
  for (const fk of allForeignKeys) {
    const fromTable = findTable(fk.fromTable);
    const toTable = findTable(fk.toTable);
    if (!fromTable || !toTable) {
      ctx.warnings.push(
        `Skipped foreign key on "${fk.fromTable}" — references unknown table "${fk.toTable}".`,
      );
      continue;
    }

    let toColumns = fk.toColumns;
    if (toColumns.length === 0) {
      const pkFields = toTable.fields.filter((field) => field.pk);
      if (pkFields.length !== 1) {
        ctx.warnings.push(
          `Skipped foreign key on "${fk.fromTable}" — "${toTable.name}" has no single-column primary key to reference.`,
        );
        continue;
      }
      toColumns = [pkFields[0]!.name];
    }

    if (fk.fromColumns.length !== toColumns.length) {
      ctx.warnings.push(
        `Skipped foreign key on "${fk.fromTable}" — column count does not match "${toTable.name}".`,
      );
      continue;
    }

    const findFromField = fieldFinders.get(fromTable.id)!;
    const findToField = fieldFinders.get(toTable.id)!;
    for (let i = 0; i < fk.fromColumns.length; i++) {
      const fromField = findFromField(fk.fromColumns[i]!);
      const toField = findToField(toColumns[i]!);
      if (!fromField || !toField) {
        ctx.warnings.push(
          `Skipped foreign key on "${fk.fromTable}" — column "${fk.fromColumns[i]}" or "${toColumns[i]}" not found.`,
        );
        continue;
      }
      const key = `${fromField.id}->${toField.id}`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      relationships.push({
        id: makeId(),
        fromTable: fromTable.id,
        fromField: fromField.id,
        toTable: toTable.id,
        toField: toField.id,
        cardinality: DEFAULT_CARDINALITY,
      });
      // Keep the FK badge in sync, exactly as applyActions does for add_relationship.
      fromField.fk = true;
    }
  }

  return { tables, relationships };
}

export function fromSql(sql: string, options?: FromSqlOptions): FromSqlResult {
  const makeId = options?.makeId ?? (() => crypto.randomUUID());
  const ctx: ParseContext = {
    tables: [],
    alterForeignKeys: [],
    primaryKeyAlters: [],
    warnings: [],
  };

  for (const statement of splitStatements(sql)) {
    dispatch(statement, ctx);
  }

  if (ctx.tables.length === 0) {
    throw new ParseError("No CREATE TABLE statements found in the SQL input.");
  }

  // Parse validates its own output before returning — invalid schema must never reach state.
  const schema = SchemaSchema.parse(buildSchema(ctx, makeId));
  return { schema, warnings: ctx.warnings };
}
