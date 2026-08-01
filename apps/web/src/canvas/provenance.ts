import type { Origin, Provenance, Table } from "@grafture/core";

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
