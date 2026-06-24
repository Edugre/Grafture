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
}
