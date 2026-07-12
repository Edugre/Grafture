import type { SourceField } from "./types.js";
import {
  collectDistinctValues,
  collectInferenceValues,
  collectSamples,
  collectStats,
} from "./sample.js";
import { inferType } from "./infer.js";

export type ParseOptions = {
  makeId?: () => string;
};

export function defaultMakeId(): string {
  return crypto.randomUUID();
}

export function resolveMakeId(opts?: ParseOptions): () => string {
  return opts?.makeId ?? defaultMakeId;
}

/** Deterministic dedupe: name, name_2, name_3, … */
export function dedupeNames(names: string[]): string[] {
  const seen = new Map<string, number>();

  return names.map((name) => {
    const count = seen.get(name) ?? 0;
    seen.set(name, count + 1);
    if (count === 0) {
      return name;
    }
    return `${name}_${count + 1}`;
  });
}

export function buildSourceField(
  values: string[],
  name: string,
  joinValues?: string[],
): SourceField {
  const distinctValues = collectDistinctValues(values);
  return {
    name,
    type: inferType(collectInferenceValues(values)),
    samples: collectSamples(values),
    stats: collectStats(values),
    distinctValues,
    // The wide join-discovery set is only worth carrying when it actually saw more distinct
    // values than the capped scan window did — otherwise it would just duplicate memory.
    ...(joinValues && joinValues.length > distinctValues.length ? { joinValues } : {}),
  };
}
