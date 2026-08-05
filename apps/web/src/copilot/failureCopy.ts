import type { Attempt, ProviderFailure } from "../ai/retry.js";

/**
 * Turns a classified provider failure into the words on the card.
 *
 * Kept as a pure function, separate from the component and from what gets persisted, for one
 * reason: only the *facts* of a failure belong in the transcript (status, kind, model id, attempt
 * ledger). Fossilising the sentences would mean a copy fix never reaches a saved project, and it
 * would make every wording change a data migration.
 *
 * Copy rules, from the design handoff:
 * - Neutral and declarative. No "Oops!", no exclamation marks, no apology.
 * - Name the actor. "Anthropic is at capacity", not "Something went wrong" — the user chose the
 *   provider, so tell them which one failed.
 * - Own our faults. A 400 is far more likely our bad tool schema than anything the user typed, and
 *   the copy says so rather than sending them hunting for a typo.
 * - Title is a short clause, sentence case, no terminal period. Cause is one sentence.
 * - Interpolate real measurements — actual attempt count, actual elapsed time, actual model id.
 *   No round numbers standing in for things we measured.
 */

/**
 * The persisted facts of a failed turn. Everything here is measured or classified; nothing here is
 * prose. Mirrors the zod schema on the error chat message.
 */
export type CopilotFailure = {
  failure: ProviderFailure;
  /** "Anthropic" | "OpenAI" | "Local" — the actor named in the title. */
  providerLabel: string;
  /** Which provider the turn ran against, for routing the card's primary action. */
  providerId: "anthropic" | "openai" | "local";
  attempts?: Attempt[] | undefined;
  requestId?: string | undefined;
  elapsedMs?: number | undefined;
  /** The per-attempt deadline that expired, so a timeout card can say "after 120s" honestly. */
  timeoutMs?: number | undefined;
  /** The model the turn ran against — named by the 403 card, which is about model access. */
  modelId?: string | undefined;
  /** How many sources were in the prompt — the 413 card explains the size in the user's terms. */
  sourceCount?: number | undefined;
  /** The user message this turn sent, so "Try again" re-sends the real text. */
  retryMessage?: string | undefined;
};

/** Red means stop reading and do something else; amber means one control away from working. */
export type Severity = "fatal" | "fixable";

/** Which glyph sits in the avatar gutter. Maps to an icon in the component. */
export type FailureGlyph = "alert" | "clock" | "server";

/**
 * What the card's primary button does. Presentation stays dumb: the panel owns the handlers, the
 * card only says which one applies.
 */
export type FailureActionId =
  | "retry" // re-send the same turn
  | "connect" // open the BYO-key / provider screen
  | "pick-model" // open the model picker
  | "test-connection" // re-run validateCredentialLive against the local endpoint
  | "none";

export type FailureCopy = {
  severity: Severity;
  glyph: FailureGlyph;
  title: string;
  cause: CausePart[];
  /**
   * Shown right-aligned in mono. Non-negotiable: it is the string users paste into a bug report,
   * and it keeps the wrapper honest — no invented friendlier codes.
   */
  statusLabel: string;
  /** Label of the primary action, or null when re-sending is the only thing left (see `weak`). */
  primary: { id: FailureActionId; label: string } | null;
  /**
   * True when the "primary" is really a coin flip (a timeout: it might work, it might not). Both
   * buttons then render as secondary — don't offer a purple button for a coin flip.
   */
  weakPrimary: boolean;
  /** The two-cause list on the local card. Empty everywhere else. */
  bullets: string[];
  /** A copyable shell command, when there is one worth running. */
  command?: string;
};

/**
 * A cause sentence is segments, not a string, because identifiers inside it render in mono — "Your
 * saved choice `claude-3-opus-20240229` is no longer in the catalog." Interpolating the id into a
 * plain string would either lose the distinction or force the component to parse its own copy.
 */
export type CausePart = string | { mono: string };

/** Every `kind` this build knows how to draw a card for. */
const KNOWN_KINDS = new Set<ProviderFailure["kind"]>([
  "rate_limited",
  "overloaded",
  "out_of_credit",
  "unauthorized",
  "unknown_model",
  "too_large",
  "malformed",
  "timeout",
  "unreachable_local",
  "transport",
]);

/**
 * Narrow a persisted failure back to the union, or `null` when this build has never heard of its
 * `kind` — a transcript saved by a newer version. The caller then falls back to rendering the raw
 * provider message, which is exactly what the app did before these cards existed. Guessing a
 * plausible card for an unknown failure would be worse: it would state a cause we never classified.
 */
export function toProviderFailure(
  raw: { kind: string } & Record<string, unknown>,
): ProviderFailure | null {
  return KNOWN_KINDS.has(raw.kind as ProviderFailure["kind"])
    ? (raw as unknown as ProviderFailure)
    : null;
}

/** Whole seconds, the way the ledger and the copy both spell durations. */
function seconds(ms: number): string {
  return `${Math.max(1, Math.round(ms / 1000))}s`;
}

function countWord(n: number): string {
  const words = ["zero", "one", "two", "three", "four", "five", "six"];
  return words[n] ?? String(n);
}

/**
 * The command that fixes a CORS refusal, chosen from the runtime the endpoint's port implies.
 * Ollama's form is the default, not the only case — LM Studio and llama.cpp need different
 * guidance, and printing the Ollama line at an LM Studio user is worse than printing nothing.
 */
export function runtimeCommand(endpoint: string): string | undefined {
  let port = "";
  try {
    port = new URL(endpoint).port;
  } catch {
    return "OLLAMA_ORIGINS=* ollama serve";
  }
  if (port === "1234") {
    // LM Studio serves CORS from its own server panel; there is no env-var incantation to print.
    return undefined;
  }
  if (port === "8080") {
    return "llama-server --host 0.0.0.0 --port 8080";
  }
  return "OLLAMA_ORIGINS=* ollama serve";
}

/** Endpoint reduced to the identifier worth showing: `localhost:11434`, not the whole URL. */
export function endpointLabel(endpoint: string): string {
  try {
    return new URL(endpoint).host;
  } catch {
    return endpoint || "local runtime";
  }
}

/** Turn the measured facts of a failed turn into the card's words. */
export function describeFailure(detail: CopilotFailure): FailureCopy {
  const { failure, providerLabel } = detail;
  const attempts = detail.attempts ?? [];

  const base = {
    weakPrimary: false,
    bullets: [] as string[],
  };

  switch (failure.kind) {
    case "overloaded": {
      // The one case where the ledger is the whole explanation: nothing about the request is wrong.
      const tried =
        attempts.length > 1 && detail.elapsedMs
          ? `${countWord(attempts.length)} attempts over ${seconds(detail.elapsedMs)} all came back overloaded`
          : `the provider answered ${failure.status} and had no capacity for it`;
      return {
        ...base,
        severity: "fatal",
        glyph: "alert",
        title: `${providerLabel} is at capacity`,
        cause: [`Nothing about the request is wrong — ${tried}.`],
        statusLabel: String(failure.status),
        primary: { id: "retry", label: "Try again" },
      };
    }

    case "rate_limited": {
      const tried =
        attempts.length > 1 && detail.elapsedMs
          ? `${countWord(attempts.length)} attempts over ${seconds(detail.elapsedMs)} were all rate limited`
          : "the request was rate limited";
      return {
        ...base,
        severity: "fatal",
        glyph: "clock",
        title: `${providerLabel} is still rate limiting this key`,
        cause: [`Backing off didn't clear it — ${tried}. Waiting a little longer is the only fix.`],
        statusLabel: String(failure.status),
        primary: { id: "retry", label: "Try again" },
      };
    }

    case "out_of_credit":
      return {
        ...base,
        severity: "fatal",
        glyph: "alert",
        title: `This ${providerLabel} account is out of credit`,
        cause: [
          "A quota limit, not a rate limit — retrying won't clear it. Add credit or switch to another key.",
        ],
        statusLabel: String(failure.status),
        primary: { id: "connect", label: "Switch provider" },
      };

    case "unauthorized": {
      // 401 and 403 differ in what went wrong, and conflating them sends the user to the wrong fix.
      const forbidden = failure.status === 403;
      return {
        ...base,
        severity: "fatal",
        glyph: "alert",
        title: forbidden
          ? `${providerLabel} refused this key for that model`
          : `${providerLabel} rejected this key`,
        cause: forbidden
          ? [
              "The key is valid but isn't allowed ",
              ...(detail.modelId ? [{ mono: detail.modelId }, " "] : ["this model "]),
              "— an org restriction or a plan limit.",
            ]
          : [
              `The key reached ${providerLabel} and was refused — it's revoked, mistyped, or from another org.`,
            ],
        statusLabel: String(failure.status),
        primary: forbidden
          ? { id: "pick-model", label: "Choose a model" }
          : { id: "connect", label: "Update key" },
      };
    }

    case "unknown_model":
      return {
        ...base,
        severity: "fixable",
        glyph: "alert",
        title: "That model isn't on this key",
        cause: failure.modelId
          ? ["Your saved choice ", { mono: failure.modelId }, " is no longer in the catalog."]
          : ["The model this key was sending to is no longer in the catalog."],
        statusLabel: String(failure.status),
        primary: { id: "pick-model", label: "Choose a model" },
      };

    case "too_large": {
      const size =
        detail.sourceCount && detail.sourceCount > 0
          ? `${countWord(detail.sourceCount)} ${detail.sourceCount === 1 ? "source" : "sources"} with wide sample values pushed the prompt past the limit`
          : "the prompt went past the provider's size limit";
      return {
        ...base,
        severity: "fixable",
        glyph: "alert",
        title: "The request was too large to send",
        cause: [
          `${size[0]!.toUpperCase()}${size.slice(1)} — narrow the scope and it'll go through.`,
        ],
        statusLabel: String(failure.status),
        primary: { id: "none", label: "" },
      };
    }

    case "malformed":
      return {
        ...base,
        severity: "fatal",
        glyph: "alert",
        // Ours, almost certainly — say so rather than implying the user typed something wrong.
        title: `${providerLabel} rejected the request as malformed`,
        cause: [
          "This is very likely Grafture's fault, not yours — an unsupported parameter or tool schema for the selected model, rather than anything in what you asked.",
        ],
        statusLabel: String(failure.status),
        primary: { id: "pick-model", label: "Try another model" },
      };

    case "timeout":
      return {
        ...base,
        severity: "fixable",
        glyph: "clock",
        title: `No response after ${detail.timeoutMs ? seconds(detail.timeoutMs) : "the deadline"}`,
        cause: [
          "The request was cut off at its deadline. It may have run to completion on the provider's side, so nothing is retried automatically.",
        ],
        statusLabel: "timeout",
        // A re-send here is a coin flip, so it gets no purple button.
        primary: { id: "retry", label: "Send again" },
        weakPrimary: true,
      };

    case "unreachable_local": {
      const command = runtimeCommand(failure.endpoint);
      return {
        ...base,
        severity: "fixable",
        glyph: "server",
        title: "Couldn't reach your local model",
        cause: ["The browser can't tell these two apart, so both are worth checking:"],
        bullets: ["The server isn't running.", "It's running but refusing this origin (CORS)."],
        ...(command ? { command } : {}),
        // The endpoint is the useful identifier here, so it takes the status slot.
        statusLabel: endpointLabel(failure.endpoint),
        primary: { id: "test-connection", label: "Test connection" },
      };
    }

    case "transport":
      return {
        ...base,
        severity: "fixable",
        glyph: "alert",
        title: `Couldn't reach ${providerLabel}`,
        cause: [
          "The request never left the browser — you may be offline, or a network policy or extension blocked the call.",
        ],
        statusLabel: "no response",
        primary: { id: "retry", label: "Send again" },
        weakPrimary: true,
      };
  }
}

/**
 * Which retry lifecycle state a persisted failure represents.
 *
 * `interrupted` is not a user cancellation — it is a non-retryable status arriving mid-backoff
 * (a 401 on attempt 2). Without naming it, the user cannot tell an abandoned retry from a crash.
 */
export type FailurePhase = "exhausted" | "interrupted" | "immediate";

export function failurePhase(detail: CopilotFailure): FailurePhase {
  const attempts = detail.attempts ?? [];
  if (attempts.length < 2) {
    return "immediate";
  }
  // Retrying only stops early when the *last* status was one we don't retry.
  const retryable = detail.failure.kind === "rate_limited" || detail.failure.kind === "overloaded";
  return retryable ? "exhausted" : "interrupted";
}

/** How the final, non-retryable status reads in a sentence — a word, never the bare code. */
function failureWord(failure: ProviderFailure): string {
  switch (failure.kind) {
    case "unauthorized":
      return "refused";
    case "out_of_credit":
      return "out of credit";
    case "unknown_model":
      return "an unknown model";
    case "too_large":
      return "too large";
    case "malformed":
      return "malformed";
    case "timeout":
      return "a timeout";
    case "unreachable_local":
    case "transport":
      return "unreachable";
    case "rate_limited":
      return "rate limited";
    case "overloaded":
      return "overloaded";
  }
}

/**
 * The cause sentence for a retry that a new, non-retryable status cut short. It explains the
 * *transition*, not just the final status — that transition is the whole reason this state exists.
 */
export function interruptedCause(detail: CopilotFailure): CausePart[] {
  const attempts = detail.attempts ?? [];
  const ordinal = ["", "first", "second", "third", "fourth"][attempts.length] ?? "latest";
  const first = attempts[0]?.status;
  const was = first === 429 ? "rate limited" : "a transient fault";
  return [
    `The ${ordinal} attempt came back ${failureWord(detail.failure)} rather than ${was}, so retrying stopped there.`,
  ];
}
