import type { SourceField } from "./types.js";
import { collectInferenceValues, collectSamples, collectStats } from "./sample.js";
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

export function buildSourceField(values: string[], name: string): SourceField {
  return {
    name,
    type: inferType(collectInferenceValues(values)),
    samples: collectSamples(values),
    stats: collectStats(values),
  };
}
