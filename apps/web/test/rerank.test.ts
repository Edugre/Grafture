import type { SuggestionRanking } from "@grafture/core";
import { describe, expect, it } from "vitest";

import { mergeRankings, parseRankingResponse, toDigest } from "../src/suggest/rerank.js";
import type {
  JoinSuggestion,
  KeySuggestion,
  TypeSuggestion,
} from "../src/suggest/joinSuggestions.js";
import type { SuggestionItem } from "../src/suggest/useSuggestions.js";

/* --- builders ------------------------------------------------------------------------------- */

function fkItem(id: string, overlapPercent = 50, warning: string | null = null): SuggestionItem {
  const join: JoinSuggestion = {
    id,
    candidate: {
      left: { sourceId: "l", sourceName: "left.csv", field: "a" },
      right: { sourceId: "r", sourceName: "right.csv", field: "b" },
      rawOverlap: 0.4,
      normalizedOverlap: overlapPercent / 100,
      sharedValues: 3,
      containmentLeft: overlapPercent / 100,
      containmentRight: overlapPercent / 100,
      requiresNormalization: warning !== null,
      formatMismatch: null,
      grain: "1:N",
    },
    leftLabel: "left.csv · a",
    rightLabel: "right.csv · b",
    overlapPercent,
    sharedValues: 3,
    warning,
    grainLabel: "1:N",
    alreadyLinked: false,
  };
  return { id, group: "fk", needsReview: warning !== null, join };
}

function pkItem(id: string): SuggestionItem {
  const key: KeySuggestion = {
    id,
    candidate: { sourceId: "s", sourceName: "s.csv", field: "id", rows: 100, reason: "unique" },
    label: "users · id",
    reason: "unique and non-null across 100 rows",
    tableName: "users",
  };
  return { id, group: "pk", needsReview: false, key };
}

function typeItem(id: string): SuggestionItem {
  const type: TypeSuggestion = {
    id,
    label: "users · age",
    tableName: "users",
    field: "age",
    currentType: "text",
    suggestedType: "int",
    reason: "data looks like int, not text",
  };
  return { id, group: "type", needsReview: false, type };
}

const ids = (items: { item: { id: string } }[]) => items.map((entry) => entry.item.id);

/* --- mergeRankings -------------------------------------------------------------------------- */

describe("mergeRankings", () => {
  it("orders ranked items by rank, ascending", () => {
    const items = [fkItem("a"), fkItem("b"), fkItem("c")];
    const rankings: SuggestionRanking[] = [
      { id: "a", rank: 2, rationale: "" },
      { id: "b", rank: 0, rationale: "" },
      { id: "c", rank: 1, rationale: "" },
    ];
    expect(ids(mergeRankings(items, rankings))).toEqual(["b", "c", "a"]);
  });

  it("appends items the model omitted, in their original detector order", () => {
    const items = [fkItem("a"), fkItem("b"), fkItem("c")];
    const rankings: SuggestionRanking[] = [{ id: "c", rank: 0, rationale: "the real FK" }];
    // c ranked first; a and b unranked → appended in original order.
    expect(ids(mergeRankings(items, rankings))).toEqual(["c", "a", "b"]);
  });

  it("drops rankings for ids that were never sent (no fabrication)", () => {
    const items = [fkItem("a"), fkItem("b")];
    const rankings: SuggestionRanking[] = [
      { id: "ghost", rank: 0, rationale: "made up" },
      { id: "b", rank: 1, rationale: "" },
    ];
    const merged = mergeRankings(items, rankings);
    expect(ids(merged)).toEqual(["b", "a"]);
    expect(merged.find((entry) => entry.item.id === "ghost")).toBeUndefined();
  });

  it("returns the original order unchanged when there are no rankings", () => {
    const items = [fkItem("a"), pkItem("b"), typeItem("c")];
    expect(ids(mergeRankings(items, []))).toEqual(["a", "b", "c"]);
  });

  it("attaches rationale and priority to ranked items only", () => {
    const items = [fkItem("a"), fkItem("b")];
    const rankings: SuggestionRanking[] = [
      { id: "a", rank: 0, rationale: "identifier match", priority: "high" },
    ];
    const merged = mergeRankings(items, rankings);
    const a = merged.find((entry) => entry.item.id === "a");
    const b = merged.find((entry) => entry.item.id === "b");
    expect(a?.rationale).toBe("identifier match");
    expect(a?.priority).toBe("high");
    expect(b?.rationale).toBeUndefined();
    expect(b?.priority).toBeUndefined();
  });

  it("keeps every input item exactly once", () => {
    const items = [fkItem("a"), pkItem("b"), typeItem("c")];
    const merged = mergeRankings(items, [{ id: "c", rank: 0, rationale: "" }]);
    expect(merged).toHaveLength(3);
    expect(new Set(ids(merged))).toEqual(new Set(["a", "b", "c"]));
  });
});

/* --- toDigest ------------------------------------------------------------------------------- */

describe("toDigest", () => {
  it("projects an fk suggestion with its stats and no sample values", () => {
    const digest = toDigest(fkItem("fk1", 72, "strip leading zeros"));
    expect(digest).toMatchObject({
      id: "fk1",
      kind: "fk",
      left: "left.csv · a",
      right: "right.csv · b",
      overlapPercent: 72,
      sharedValues: 3,
      grain: "1:N",
      needsNormalization: true,
    });
    expect(JSON.stringify(digest)).not.toContain("samples");
  });

  it("projects pk and type suggestions with their reason", () => {
    expect(toDigest(pkItem("pk1"))).toMatchObject({ id: "pk1", kind: "pk", left: "users · id" });
    expect(toDigest(typeItem("ty1"))).toMatchObject({
      id: "ty1",
      kind: "type",
      left: "users · age",
    });
  });
});

/* --- parseRankingResponse ------------------------------------------------------------------- */

describe("parseRankingResponse", () => {
  it("parses a plain JSON object", () => {
    const out = parseRankingResponse('{"rankings":[{"id":"a","rank":0,"rationale":"x"}]}');
    expect(out).toEqual([{ id: "a", rank: 0, rationale: "x" }]);
  });

  it("tolerates markdown code fences", () => {
    const out = parseRankingResponse(
      '```json\n{"rankings":[{"id":"a","rank":1,"rationale":"y"}]}\n```',
    );
    expect(out).toEqual([{ id: "a", rank: 1, rationale: "y" }]);
  });

  it("rejects non-JSON", () => {
    expect(parseRankingResponse("not json")).toEqual({ error: expect.any(String) });
  });

  it("rejects a payload missing the rankings array", () => {
    expect(parseRankingResponse('{"foo":1}')).toEqual({ error: expect.any(String) });
  });

  it("rejects rankings entries of the wrong shape", () => {
    expect(parseRankingResponse('{"rankings":[{"id":"a"}]}')).toEqual({
      error: expect.any(String),
    });
  });
});
