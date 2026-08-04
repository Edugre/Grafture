import { z } from "zod";

/** One row of the retry ledger. Mirrors `Attempt` in `ai/retry.ts`. */
const AttemptSchema = z.object({
  n: z.number(),
  status: z.union([z.number(), z.literal("timeout"), z.literal("transport")]),
  waitedMs: z.number().optional(),
  fromRetryAfter: z.boolean().optional(),
});

/**
 * The classified failure, mirroring `ProviderFailure` in `ai/retry.ts`. Kept as a permissive
 * object rather than a discriminated union at the persistence boundary: a project saved by a newer
 * build can carry a `kind` this one has never heard of, and rejecting the whole transcript over an
 * unknown error card would be a worse failure than rendering it generically.
 */
const ProviderFailureSchema = z.object({
  kind: z.string(),
  status: z.number().optional(),
  retryAfterMs: z.number().optional(),
  modelId: z.string().optional(),
  endpoint: z.string().optional(),
});

/**
 * What a failed copilot turn records. Only measured facts — statuses, the attempt ledger, the
 * request id, the model. The sentences on the card are derived at render time by
 * `failureCopy.ts`, so a copy fix reaches projects saved before it was written.
 */
export const CopilotFailureSchema = z.object({
  failure: ProviderFailureSchema,
  providerLabel: z.string(),
  providerId: z.enum(["anthropic", "openai", "local"]),
  attempts: z.array(AttemptSchema).optional(),
  requestId: z.string().optional(),
  elapsedMs: z.number().optional(),
  timeoutMs: z.number().optional(),
  modelId: z.string().optional(),
  sourceCount: z.number().optional(),
  retryMessage: z.string().optional(),
});

/** The ledger a turn that *recovered* carries — folded to one line above the reply. */
const RecoveredRetrySchema = z.object({
  attempts: z.array(AttemptSchema),
  totalMs: z.number(),
  /** True when the user pressed Stop rather than the retries succeeding. */
  stopped: z.boolean().optional(),
});

/**
 * Copilot chat messages. This is a web/app concept (not part of the core domain model), but it
 * is persisted with the project, so it carries a zod schema for validating untrusted imports.
 */
export const ChatMessageSchema = z.discriminatedUnion("role", [
  z.object({
    id: z.string(),
    role: z.literal("user"),
    text: z.string(),
  }),
  z.object({
    id: z.string(),
    role: z.literal("assistant"),
    text: z.string(),
    applied: z.array(z.string()).optional(),
    rejected: z.array(z.string()).optional(),
    /**
     * A provider note about how the turn ran (e.g. a local model without tool calling fell back to
     * JSON mode). Kept out of `text` so it is never replayed to the model as its own words —
     * `buildConversationHistory` sends only `text`.
     */
    notice: z.string().optional(),
    /**
     * Present when the turn only succeeded after backing off. A successful turn should not wear
     * its history at full weight, so this renders as one collapsed line — but the record is kept.
     */
    retry: RecoveredRetrySchema.optional(),
  }),
  z.object({
    id: z.string(),
    role: z.literal("error"),
    /**
     * The raw provider message. Still the fallback rendering, and still what a project saved
     * before the error cards existed contains — hence `detail` being optional forever.
     */
    text: z.string(),
    detail: CopilotFailureSchema.optional(),
  }),
]);

export type ChatMessage = z.infer<typeof ChatMessageSchema>;

export function nextMessageId(): string {
  return `msg-${crypto.randomUUID()}`;
}
