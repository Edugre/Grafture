import type { Schema } from "../model.js";
import type { ParsedSource } from "../parse/index.js";

/**
 * The model's view of where the request stands, used to drive the correction loop:
 * - "complete": the request is satisfied; stop.
 * - "needs_revision": more work or a fix is expected; the loop may continue.
 * - "blocked": the goal cannot be achieved (explained in `reply`); stop.
 */
export type CopilotStatus = "complete" | "needs_revision" | "blocked";

export type AiProviderResult = {
  reply: string;
  actions: unknown[];
  status?: CopilotStatus;
};

/** A prior turn in the copilot conversation, in the order it occurred. */
export type ConversationTurn = {
  role: "user" | "assistant";
  content: string;
};

/**
 * A lossy projection of one already-detected suggestion, sent to the model for reranking. Carries
 * only the stats the detectors already computed — never raw sample values (privacy + token cost).
 * `id` echoes the consumer's suggestion id so a returned {@link SuggestionRanking} can be matched
 * back; rankings whose id isn't in the sent set are dropped (the model cannot fabricate).
 */
export type SuggestionDigest = {
  id: string;
  kind: "pk" | "fk" | "type";
  /** Human label for the (left) field, e.g. "facilities · facility_id". */
  left: string;
  /** Right-hand field label — fk suggestions only. */
  right?: string;
  /** Normalized value overlap as a whole-number percent — fk only. */
  overlapPercent?: number;
  /** Count of shared normalized values — fk only. */
  sharedValues?: number;
  /** Inferred relationship grain, e.g. "1:N" — fk only. */
  grain?: string | null;
  /** True when the join needs normalization before the columns will match — fk only. */
  needsNormalization?: boolean;
  /** Detector justification — pk/type suggestions. */
  reason?: string;
};

/**
 * The model's verdict on one suggestion: where it should sit (`rank`, ascending) and why
 * (`rationale`, one line shown under the card). `priority` is an optional emphasis hint. Reranking
 * is presentation-only: it can demote, promote, and explain, but never invents, gates, or removes a
 * suggestion (the detectors remain the source of truth).
 */
export type SuggestionRanking = {
  id: string;
  rank: number;
  rationale: string;
  priority?: "high" | "normal" | "low";
};

export interface AiProvider {
  /**
   * Propose a reply + actions for `message`. `history` carries earlier turns so the model can
   * resolve follow-ups ("link them on that key", "do the second one"); it excludes the current
   * `message`. The live schema/sources are always passed fresh, so history only needs the dialogue.
   */
  propose(
    schema: Schema,
    sources: ParsedSource[],
    message: string,
    history?: ConversationTurn[],
  ): Promise<AiProviderResult>;

  /**
   * Optional: reorder + annotate already-detected suggestions by how likely a data engineer is to
   * want them. Receives the live schema/sources for naming + grain context and the candidate
   * digests; returns a ranking per suggestion. Optional so providers (and tests) need not implement
   * it — consumers feature-detect and fall back to the deterministic detector order when absent.
   */
  rankSuggestions?(
    schema: Schema,
    sources: ParsedSource[],
    candidates: SuggestionDigest[],
  ): Promise<SuggestionRanking[]>;
}
