import type { Source } from "@grafture/core";

/**
 * Is the bundled demo pair (`apps/web/public/demo/`) what's loaded?
 *
 * Three of the tour's cards were written against that dataset and assert facts about it — that the
 * project holds HRSA health-center sites and covered entities, and that the detectors matched a
 * grant number across two columns whose names disagree with leading zeros on one side. Those
 * sentences are true of the demo and false of everything else, so they have to be gated on the data
 * actually being there rather than on the project merely having files.
 *
 * The check is deliberately narrow: both file stems **and** both join columns. The strongest claim
 * the copy makes is step 6's, about the specific `grant_number` ↔ `grant_num` mismatch, so the
 * predicate verifies exactly that claim rather than approximating it from the file names. Matching
 * on names alone would hand the demo copy to anyone who happened to call a file `health_centers`.
 *
 * Pure and cheap — name and field comparison only, no detector work. It runs when the tour opens.
 */

const DEMO_FILE_STEMS = ["health_centers", "covered_entities"];
const DEMO_JOIN_FIELDS = ["grant_number", "grant_num"];

/** `covered_entities.json` → `covered_entities`. A child source (`…json.addresses`) won't match. */
function stem(name: string): string {
  return name.toLowerCase().replace(/\.[^.]+$/, "");
}

export function isDemoDataset(sources: readonly Source[]): boolean {
  const stems = new Set(sources.map((source) => stem(source.name)));
  if (!DEMO_FILE_STEMS.every((wanted) => stems.has(wanted))) {
    return false;
  }

  const fields = new Set(
    sources.flatMap((source) => source.fields.map((field) => field.name.toLowerCase())),
  );
  return DEMO_JOIN_FIELDS.every((wanted) => fields.has(wanted));
}
