import type { Schema } from "../model.js";
import type { ParsedSource } from "../parse/index.js";

export type AiProviderResult = {
  reply: string;
  actions: unknown[];
};

export interface AiProvider {
  propose(schema: Schema, sources: ParsedSource[], message: string): Promise<AiProviderResult>;
}
