import type { Origin, Provenance, Rationale, Schema, Table } from "@grafture/core";

import type { RationaleFocus } from "../store/index.js";

/**
 * Presentation-side reading of provenance. Pure functions of the entity — no store access — so the
 * canvas can call them per row during render.
 */

/** Absent provenance reads as `user`: an unattributed entity is the user's, as core assumes. */
export function originOf(entity: { provenance?: Provenance | undefined }): Origin {
  return entity.provenance?.origin ?? "user";
}

export type TableOrigin = Origin | "mixed";

/**
 * A table's overall origin is **derived** from its own name-provenance plus its fields, never
 * stored — that is what stops one hand-renamed field from rewriting the whole table. A table whose
 * parts disagree is `mixed`, which is a real and common state (the copilot adding a column to a
 * hand-built table), not an error.
 */
export function tableOrigin(table: Table): TableOrigin {
  const origins = new Set<Origin>([originOf(table), ...table.fields.map(originOf)]);
  const [only] = [...origins];
  return origins.size === 1 && only ? only : "mixed";
}

/** True when someone other than the creator has since modified the entity. */
export function isTouched(entity: { provenance?: Provenance | undefined }): boolean {
  return entity.provenance?.touched ?? false;
}

/**
 * A rationale on a `touched` entity is stale: it explains a state the entity has since left. It is
 * still shown — the gap between the claim and the edit is the useful part — but never as current.
 */
export function isStaleRationale(entity: { provenance?: Provenance | undefined }): boolean {
  return entity.provenance?.rationale !== undefined && isTouched(entity);
}

const ORIGIN_NOUN: Record<TableOrigin, string> = {
  ai: "the AI copilot",
  user: "you",
  imported: "an imported file",
  mixed: "several sources",
};

/**
 * The text channel that carries the same meaning as the colour marker. Provenance must never be
 * conveyed by hue alone, so every marker gets this as its `title` and accessible name.
 */
export function provenanceLabel(
  origin: TableOrigin,
  opts?: { touched?: boolean; what?: string },
): string {
  const what = opts?.what ?? "Created";
  const base = `${what} by ${ORIGIN_NOUN[origin]}`;
  return opts?.touched ? `${base}, edited since` : base;
}

export type ResolvedRationale = {
  /** What the explanation is about, e.g. `orders.customer_id` or `orders → customers`. */
  subject: string;
  kind: "table" | "field" | "relationship";
  origin: Origin;
  stale: boolean;
  rationale: Rationale;
};

/**
 * Resolve a focus to the entity's **current** rationale, or null when it no longer has one (the
 * entity was deleted, or the copilot's explanation was dropped). Reading through the live schema
 * rather than caching at click time is what lets the open panel start saying "edited since" the
 * moment the user changes the thing it describes.
 */
export function resolveRationale(
  schema: Schema,
  focus: RationaleFocus | null,
): ResolvedRationale | null {
  if (!focus) {
    return null;
  }

  if (focus.kind === "relationship") {
    const relationship = schema.relationships.find(
      (candidate) => candidate.id === focus.relationshipId,
    );
    const rationale = relationship?.provenance?.rationale;
    if (!relationship || !rationale) {
      return null;
    }
    const from = schema.tables.find((candidate) => candidate.id === relationship.fromTable);
    const to = schema.tables.find((candidate) => candidate.id === relationship.toTable);
    const fromField = from?.fields.find((candidate) => candidate.id === relationship.fromField);
    const toField = to?.fields.find((candidate) => candidate.id === relationship.toField);
    return {
      subject: `${from?.name ?? "?"}.${fromField?.name ?? "?"} → ${to?.name ?? "?"}.${
        toField?.name ?? "?"
      }`,
      kind: "relationship",
      origin: originOf(relationship),
      stale: isStaleRationale(relationship),
      rationale,
    };
  }

  const table = schema.tables.find((candidate) => candidate.id === focus.tableId);
  if (!table) {
    return null;
  }

  if (focus.kind === "table") {
    const rationale = table.provenance?.rationale;
    return rationale
      ? {
          subject: table.name,
          kind: "table",
          origin: originOf(table),
          stale: isStaleRationale(table),
          rationale,
        }
      : null;
  }

  const field = table.fields.find((candidate) => candidate.id === focus.fieldId);
  const rationale = field?.provenance?.rationale;
  return field && rationale
    ? {
        subject: `${table.name}.${field.name}`,
        kind: "field",
        origin: originOf(field),
        stale: isStaleRationale(field),
        rationale,
      }
    : null;
}
