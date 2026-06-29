import { useEffect, useMemo, useRef, useState } from "react";

import { useAiProvider } from "../ai/useAiProvider.js";
import { useSchemaStore } from "../store/index.js";
import { mergeRankings, toDigest, type RankedItem } from "./rerank.js";
import { useRerankPreference } from "./rerankPreference.js";
import type { SuggestionsApi } from "./useSuggestions.js";

/**
 * The optional LLM rerank layer over {@link useSuggestions}. Detectors stay the source of truth;
 * this hook only reorders + annotates `api.open` when the user has opted in and a key is present.
 * It degrades to the deterministic order on every off-path — no key, opt-out, single suggestion, or
 * any failure — so the suggestions UI is never worse than without it.
 *
 * - "fallback": deterministic order, no annotations (the default and every error path).
 * - "ranking": a call is in flight; we keep showing the deterministic order meanwhile.
 * - "ranked": the model's order + rationales are applied.
 */
export type RankStatus = "fallback" | "ranking" | "ranked";

export type RankedSuggestions = {
  ranked: RankedItem[];
  status: RankStatus;
};

/** Wait this long after the suggestion set settles before calling — avoids firing mid-edit. */
const DEBOUNCE_MS = 500;

const fallbackOf = (api: SuggestionsApi): RankedItem[] => api.open.map((item) => ({ item }));

export function useRankedSuggestions(api: SuggestionsApi): RankedSuggestions {
  const provider = useAiProvider();
  const { enabled } = useRerankPreference();
  const canRank = enabled && provider?.rankSuggestions !== undefined && api.open.length > 1;

  // The digests are both the request payload and a stable cache key: identical detector output
  // produces an identical string, so an unchanged suggestion set never re-calls.
  const digests = useMemo(() => api.open.map(toDigest), [api.open]);
  const cacheKey = useMemo(() => JSON.stringify(digests), [digests]);

  const [result, setResult] = useState<RankedSuggestions>(() => ({
    ranked: fallbackOf(api),
    status: "fallback",
  }));

  // Remember rankings we've already fetched for a given suggestion set, keyed by the digest string,
  // so toggling tabs or re-deriving the same set reuses the result instead of paying for it again.
  const cacheRef = useRef(new Map<string, RankedItem[]>());

  useEffect(() => {
    if (!canRank) {
      setResult({ ranked: fallbackOf(api), status: "fallback" });
      return;
    }

    const cached = cacheRef.current.get(cacheKey);
    if (cached) {
      setResult({ ranked: cached, status: "ranked" });
      return;
    }

    // Show the deterministic order while the call is in flight, not a blank/stale list.
    setResult({ ranked: fallbackOf(api), status: "ranking" });

    let cancelled = false;
    const timer = setTimeout(() => {
      const { schema, sources } = useSchemaStore.getState();
      void provider!.rankSuggestions!(schema, sources, digests)
        .then((rankings) => {
          if (cancelled) {
            return; // a newer set superseded this request — ignore the stale response
          }
          const ranked = mergeRankings(api.open, rankings);
          cacheRef.current.set(cacheKey, ranked);
          setResult({ ranked, status: "ranked" });
        })
        .catch(() => {
          if (!cancelled) {
            setResult({ ranked: fallbackOf(api), status: "fallback" });
          }
        });
    }, DEBOUNCE_MS);

    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
    // `api` is intentionally excluded: `cacheKey` already captures the suggestion set, and `api`'s
    // identity changes on unrelated store updates (it would refire the call needlessly).
  }, [canRank, cacheKey, provider, digests]);

  return result;
}
