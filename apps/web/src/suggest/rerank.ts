import type { SuggestionDigest, SuggestionRanking } from "@schema-studio/core";
import { z } from "zod";

import { extractJsonObject } from "../copilot/parseResponse.js";
import type { SuggestionItem } from "./useSuggestions.js";

/**
 * The optional LLM rerank pass over the deterministic suggestion list (see useRankedSuggestions).
 * The model reorders + annotates already-detected suggestions; this module owns the two pure pieces
 * that keep that safe: projecting an item to a {@link SuggestionDigest} the model sees, and merging
 * its {@link SuggestionRanking}s back over the original list. The merge enforces the invariants —
 * the model can demote, promote, and explain, but never invents, gates, or removes a suggestion.
 */

/** One suggestion paired with its (optional) model annotation. `rationale`/`priority` are absent on
 *  the deterministic fallback path and on any item the model didn't rank. */
export type RankedItem = {
  item: SuggestionItem;
  rationale?: string;
  priority?: "high" | "normal" | "low";
};

/** Project a suggestion to the lossy digest sent to the model — stats only, never sample values. */
export function toDigest(item: SuggestionItem): SuggestionDigest {
  if (item.group === "fk") {
    const { join } = item;
    return {
      id: item.id,
      kind: "fk",
      left: join.leftLabel,
      right: join.rightLabel,
      overlapPercent: join.overlapPercent,
      sharedValues: join.sharedValues,
      grain: join.grainLabel,
      needsNormalization: join.warning !== null,
    };
  }

  if (item.group === "pk") {
    return { id: item.id, kind: "pk", left: item.key.label, reason: item.key.reason };
  }

  return { id: item.id, kind: "type", left: item.type.label, reason: item.type.reason };
}

/**
 * Merge model rankings over the detector-ordered list. Ranked items come first, sorted by `rank`;
 * any item the model omitted is appended in its original order (demote, not hide). Rankings whose id
 * isn't in `items` are ignored (the model cannot fabricate). `items` is the source of truth: every
 * input item appears exactly once in the output.
 */
export function mergeRankings(
  items: SuggestionItem[],
  rankings: SuggestionRanking[],
): RankedItem[] {
  const order = new Map(items.map((item, index) => [item.id, index]));
  const rankById = new Map<string, SuggestionRanking>();
  for (const ranking of rankings) {
    // Drop unknown ids; keep the first ranking for any duplicate id.
    if (order.has(ranking.id) && !rankById.has(ranking.id)) {
      rankById.set(ranking.id, ranking);
    }
  }

  const ranked: SuggestionItem[] = [];
  const unranked: SuggestionItem[] = [];
  for (const item of items) {
    (rankById.has(item.id) ? ranked : unranked).push(item);
  }

  ranked.sort((a, b) => {
    const ra = rankById.get(a.id);
    const rb = rankById.get(b.id);
    // Ties (and the impossible undefined) fall back to the original detector order.
    return (ra?.rank ?? 0) - (rb?.rank ?? 0) || (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0);
  });

  return [...ranked, ...unranked].map((item) => {
    const ranking = rankById.get(item.id);
    if (!ranking) {
      return { item };
    }
    return {
      item,
      rationale: ranking.rationale,
      ...(ranking.priority ? { priority: ranking.priority } : {}),
    };
  });
}

const RankingSchema = z.object({
  id: z.string(),
  rank: z.number(),
  rationale: z.string(),
  priority: z.enum(["high", "normal", "low"]).optional(),
});

const RankingResponseSchema = z.object({
  rankings: z.array(RankingSchema),
});

export type ParseRankingError = { error: string };

/**
 * Parse the model's rerank response into rankings. Tolerates markdown fences around the JSON (reuses
 * the copilot's {@link extractJsonObject}). A malformed payload returns an error so the caller can
 * fall back to the deterministic order rather than acting on garbage.
 */
export function parseRankingResponse(text: string): SuggestionRanking[] | ParseRankingError {
  let parsed: unknown;
  try {
    parsed = JSON.parse(extractJsonObject(text));
  } catch {
    return { error: "Rerank response was not valid JSON." };
  }

  const result = RankingResponseSchema.safeParse(parsed);
  if (!result.success) {
    return { error: "Rerank response did not match the expected shape." };
  }

  // Rebuild each entry so an absent `priority` is omitted rather than set to `undefined`
  // (exactOptionalPropertyTypes).
  return result.data.rankings.map((ranking) => ({
    id: ranking.id,
    rank: ranking.rank,
    rationale: ranking.rationale,
    ...(ranking.priority ? { priority: ranking.priority } : {}),
  }));
}
