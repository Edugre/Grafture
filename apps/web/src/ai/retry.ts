/**
 * Retry/backoff wrapper and failure classification for the BYO-key providers.
 *
 * Before this existed, every provider call was a bare `fetch` whose first non-OK response was
 * thrown as `Error("Anthropic API error (529): {…}")` — a 400 and a 529 were indistinguishable to
 * the user and nothing was ever retried. This module keeps that message shape (see
 * {@link ProviderError}) while attaching a typed {@link ProviderFailure} the UI can reason about,
 * and retries the handful of statuses where retrying actually helps.
 *
 * Retryability is keyed on the failure, never on the status alone: a 429 carrying
 * `insufficient_quota` says "rate limit" in its status line and "the account is out of money" in
 * its body, and a wrapper that only reads the status will hammer a dead account.
 *
 * Behaviour reference: `docs/ai-provider-error-codes.md`.
 */

/** Which provider family a call was made against — decides how an ambiguous status is read. */
export type ProviderFamily = "anthropic" | "openai" | "local";

/**
 * A classified provider failure. The discriminant is what the UI branches on to pick a card; the
 * status is carried alongside because the card always shows the real code (users paste it into bug
 * reports, and it keeps this wrapper honest — no invented friendlier codes).
 */
export type ProviderFailure =
  | { kind: "rate_limited"; status: 429; retryAfterMs?: number }
  | { kind: "overloaded"; status: number }
  | { kind: "out_of_credit"; status: 429 }
  | { kind: "unauthorized"; status: number }
  | { kind: "unknown_model"; status: 404; modelId: string }
  | { kind: "too_large"; status: number }
  | { kind: "malformed"; status: number }
  | { kind: "timeout" }
  | { kind: "unreachable_local"; endpoint: string }
  | { kind: "transport" };

/** One row of the attempt ledger: what the attempt returned and how long we waited after it. */
export type Attempt = {
  n: number;
  status: number | "timeout" | "transport";
  // `| undefined` throughout: these types round-trip through the persisted transcript's zod
  // schema, whose `.optional()` infers `T | undefined`, and the app builds with
  // `exactOptionalPropertyTypes`.
  waitedMs?: number | undefined;
  fromRetryAfter?: boolean | undefined;
};

/**
 * Which call is being retried.
 *
 * Only `message` is *visible* — it is the one call a user is sitting and waiting for, and the only
 * one whose backoff belongs on screen. `models` and `rerank` are background enrichment whose
 * failure the caller absorbs (static catalog / deterministic order), so they retry short, shallow,
 * and silently. Getting this wrong is not cosmetic: a background rerank that published its backoff
 * would paint the retry block over a chat turn that never made the request.
 */
export type RetryOperation = "message" | "models" | "rerank";

/** Everything the classifier and the UI need to name the actor and the thing that failed. */
export type RetryContext = {
  /** Human label prefixed onto thrown messages: "Anthropic" | "OpenAI" | "Local". */
  label: string;
  family: ProviderFamily;
  operation: RetryOperation;
  /** The model id sent on the request — surfaced by the unknown-model card. */
  modelId?: string;
  /** Base URL of a local runtime — surfaced by the local-unreachable card instead of a status. */
  endpoint?: string;
  /**
   * The per-attempt deadline in force, so a timeout card can say "No response after 120s" from the
   * real number rather than a plausible-looking one.
   */
  attemptTimeoutMs?: number;
};

/**
 * The backoff budget for one operation. Deliberately per-provider *and* per-operation: model
 * listings must stay short because `listModels()` throwing is the signal for callers to fall back
 * to the static catalog, and a long retry there just delays the fallback.
 */
export type RetryPolicy = {
  /** Total attempts including the first. The copilot is interactive; 3 is the ceiling. */
  maxAttempts: number;
  baseDelayMs: number;
  maxDelayMs: number;
  /**
   * Wall-clock ceiling for the whole call. `AbortSignal.timeout` deadlines are *per attempt*, so
   * without this a 3-attempt retry of a 120s request has a 360s worst case.
   */
  overallBudgetMs: number;
  /** Per-attempt deadline, used to decide whether another attempt still fits in the budget. */
  attemptTimeoutMs: number;
  /**
   * Lower caps for specific statuses. Local runtimes use `{ 500: 2 }`: a 500 from a local server is
   * usually a genuine model crash (OOM), and an OOM reproduces on retry.
   */
  maxAttemptsByStatus?: Record<number, number>;
};

/** Test/observation seams. Real implementations are the defaults; tests pass instant ones. */
export type RetryEnvironment = {
  now: () => number;
  /** Resolves after `ms`, or immediately when `signal` aborts. Never rejects. */
  wait: (ms: number, signal: AbortSignal) => Promise<void>;
};

const DEFAULT_ENVIRONMENT: RetryEnvironment = {
  now: () => Date.now(),
  wait: (ms, signal) =>
    new Promise<void>((resolve) => {
      if (signal.aborted) {
        resolve();
        return;
      }
      const timer = setTimeout(finish, ms);
      signal.addEventListener("abort", finish, { once: true });
      function finish() {
        clearTimeout(timer);
        signal.removeEventListener("abort", finish);
        resolve();
      }
    }),
};

/**
 * A classified provider failure, thrown so it can travel up through the agent loop untouched.
 *
 * **The `message` keeps the historical `{label} API error ({status}): {body}` shape.** It is not
 * decoration: `validateCredential.ts` regex-matches `/\((401|403)\)/` against it to tell a rejected
 * credential from an unreachable server. Typed consumers should read {@link failure} instead, but
 * the string stays parseable.
 */
export class ProviderError extends Error {
  constructor(
    message: string,
    readonly failure: ProviderFailure,
    readonly context: RetryContext,
    /** Ledger of every attempt made before giving up. Empty when the first call failed fatally. */
    readonly attempts: Attempt[] = [],
    /** Anthropic's `request_id` — what their support traces on. Preserved verbatim. */
    readonly requestId?: string,
    /** Wall-clock time spent across all attempts, for "three attempts over 14s". */
    readonly elapsedMs = 0,
  ) {
    super(message);
    this.name = "ProviderError";
  }

  /** True when the user pressed Stop rather than the provider failing. */
  static isStopped(error: unknown): boolean {
    return error instanceof DOMException && error.name === "AbortError";
  }
}

/** Thrown out of the retry loop when the user stopped it. Carries the ledger so the turn can show it. */
export class RetryStoppedError extends Error {
  constructor(
    readonly attempts: Attempt[],
    readonly elapsedMs: number,
  ) {
    super("Retrying was stopped.");
    this.name = "RetryStoppedError";
  }
}

// ---------------------------------------------------------------------------
// Classification
// ---------------------------------------------------------------------------

/** The error envelope both families use, as much of it as we rely on. */
type ErrorBody = {
  error?: { type?: unknown; code?: unknown; message?: unknown };
  request_id?: unknown;
};

function parseErrorBody(raw: string): ErrorBody {
  try {
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === "object" && parsed !== null ? (parsed as ErrorBody) : {};
  } catch {
    return {};
  }
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

/** `retry-after` is either delta-seconds or an HTTP date. Both are advisory outside a 429. */
function parseRetryAfter(header: string | null, now: number): number | undefined {
  if (!header) {
    return undefined;
  }
  const seconds = Number(header.trim());
  if (Number.isFinite(seconds) && seconds >= 0) {
    return seconds * 1000;
  }
  const date = Date.parse(header);
  return Number.isNaN(date) ? undefined : Math.max(0, date - now);
}

/**
 * Does this 400 mean "too big" rather than "malformed"? Anthropic uses a 413 with
 * `request_too_large`, but several OpenAI-compatible runtimes return a 400 for the same condition,
 * and telling a user their request was malformed when it was merely oversized sends them looking
 * for a typo that isn't there.
 */
function readsAsTooLarge(body: ErrorBody): boolean {
  const type = asString(body.error?.type);
  const message = asString(body.error?.message);
  return (
    type === "request_too_large" ||
    /too large|too long|maximum context|context length|reduce the length/i.test(message)
  );
}

/** OpenAI signals a dead account with `insufficient_quota` under a 429 that claims to be a rate limit. */
function readsAsOutOfCredit(body: ErrorBody): boolean {
  return (
    asString(body.error?.type) === "insufficient_quota" ||
    asString(body.error?.code) === "insufficient_quota"
  );
}

/** Classify a non-OK HTTP response into the typed union. `raw` is the already-read body text. */
export function classifyResponse(
  status: number,
  raw: string,
  headers: Headers | undefined,
  context: RetryContext,
  now: number,
): ProviderFailure {
  const body = parseErrorBody(raw);

  if (status === 429) {
    if (readsAsOutOfCredit(body)) {
      return { kind: "out_of_credit", status: 429 };
    }
    const retryAfterMs = parseRetryAfter(headers?.get("retry-after") ?? null, now);
    return retryAfterMs === undefined
      ? { kind: "rate_limited", status: 429 }
      : { kind: "rate_limited", status: 429, retryAfterMs };
  }

  if (status === 401 || status === 403) {
    return { kind: "unauthorized", status };
  }

  if (status === 404) {
    // A 404 from a local runtime is genuinely ambiguous — wrong base URL (a missing `/v1`), or the
    // endpoint is there but the model was never pulled. The local card names both rather than guess.
    if (context.family === "local") {
      return { kind: "unreachable_local", endpoint: context.endpoint ?? "" };
    }
    // Only a *message* 404 is about the model. A 404 on the listing endpoint is about the URL, and
    // naming the chat model for it would point the user at the wrong fix. (Listing failures fall
    // back to the static catalog and never render a card — but a classification that lies is a lie
    // waiting for the day something does read it.)
    return {
      kind: "unknown_model",
      status: 404,
      modelId: context.operation === "message" ? (context.modelId ?? "") : "",
    };
  }

  if (status === 413) {
    return { kind: "too_large", status };
  }

  if (status === 400 || status === 422) {
    return readsAsTooLarge(body) ? { kind: "too_large", status } : { kind: "malformed", status };
  }

  if (status >= 500) {
    return { kind: "overloaded", status };
  }

  return { kind: "malformed", status };
}

/** Classify a rejected `fetch` — no HTTP status ever arrived. */
export function classifyThrown(error: unknown, context: RetryContext): ProviderFailure {
  // `AbortSignal.timeout` rejects with a DOMException, not an HTTP status.
  if (error instanceof DOMException && error.name === "TimeoutError") {
    return { kind: "timeout" };
  }
  if (context.family === "local") {
    return { kind: "unreachable_local", endpoint: context.endpoint ?? "" };
  }
  return { kind: "transport" };
}

/** Build the `ProviderError` for a non-OK response, preserving the legacy message shape. */
export async function providerErrorFromResponse(
  response: Response,
  context: RetryContext,
  now: number = Date.now(),
): Promise<ProviderError> {
  const raw = await response.text();
  const failure = classifyResponse(response.status, raw, response.headers, context, now);
  const requestId = asString(parseErrorBody(raw).request_id) || undefined;
  // `{label} API error ({status}): {body}` / `{label} Models API error (...)` — unchanged from
  // before the wrapper existed, because validateCredential.ts parses the "(401)" out of it.
  const surface = context.operation === "models" ? "Models API" : "API";
  const message = `${context.label} ${surface} error (${response.status}): ${raw}`;
  return new ProviderError(message, failure, context, [], requestId);
}

// ---------------------------------------------------------------------------
// Policy
// ---------------------------------------------------------------------------

/**
 * Is this failure worth trying again? Retryable: 429 (a real rate limit), 500, 502, 503, 504, 529.
 * Everything else fails fast — including a described local transport error, because retrying "your
 * server isn't running" is pure latency, and a timeout, because the work may have completed
 * server-side and a retry doubles an already-long wait.
 */
export function isRetryable(failure: ProviderFailure): boolean {
  return failure.kind === "rate_limited" || failure.kind === "overloaded";
}

/** How many attempts this specific failure gets, honouring any lower per-status cap. */
function attemptCap(policy: RetryPolicy, failure: ProviderFailure): number {
  const status = "status" in failure ? failure.status : undefined;
  const override = status === undefined ? undefined : policy.maxAttemptsByStatus?.[status];
  return Math.min(policy.maxAttempts, override ?? policy.maxAttempts);
}

/**
 * Backoff for attempt `n` (1-based). Exponential from the base, capped, then jittered ±25% so a
 * fleet of clients that hit the same 529 doesn't return in lockstep. A provider-supplied
 * `retry-after` wins outright — it is an instruction, not a suggestion.
 */
export function backoffMs(
  policy: RetryPolicy,
  attempt: number,
  failure: ProviderFailure,
  random: () => number = Math.random,
): { waitMs: number; fromRetryAfter: boolean } {
  if (failure.kind === "rate_limited" && failure.retryAfterMs !== undefined) {
    // Uncapped, deliberately. Clamping to `maxDelayMs` meant a `retry-after: 60` was answered
    // after 16s — re-hitting a key the provider had just told us to leave alone. The overall
    // budget is what decides whether a long wait is worth starting; the header decides how long.
    return { waitMs: failure.retryAfterMs, fromRetryAfter: true };
  }
  const exponential = policy.baseDelayMs * 2 ** (attempt - 1);
  const capped = Math.min(exponential, policy.maxDelayMs);
  return { waitMs: Math.round(capped * (0.75 + random() * 0.5)), fromRetryAfter: false };
}

// ---------------------------------------------------------------------------
// Live progress channel
// ---------------------------------------------------------------------------

/**
 * What the copilot panel needs to render the "backing off" block. `stop` aborts the in-flight
 * request *and* cancels the scheduled retry — a stop that only cancelled the timer would leave a
 * request in flight writing into a turn the user abandoned.
 */
export type RetryProgress = {
  attempts: Attempt[];
  waitMs: number;
  /** Absolute time the next attempt fires. Derive the countdown from this, never by decrementing. */
  nextAttemptAt: number;
  /** Total attempts this call is allowed, so the ledger can show the pending final row. */
  maxAttempts: number;
  failure: ProviderFailure;
  context: RetryContext;
  stop: () => void;
};

/**
 * `settled` closes a backoff episode — the retry succeeded, gave up, or was stopped. It carries the
 * finished ledger and the measured elapsed time so the panel never has to reconstruct either from
 * the timing of the events it happened to observe.
 */
export type RetryEvent =
  | { type: "waiting"; progress: RetryProgress }
  /** The backoff wait ended; this attempt is now in flight. Not the end of the episode. */
  | { type: "attempting"; attempt: number; attempts: Attempt[] }
  | { type: "settled"; attempts: Attempt[]; elapsedMs: number; stopped: boolean };

const listeners = new Set<(event: RetryEvent) => void>();

/**
 * Observe retry backoff as it happens. Only `message` calls publish; `models` and `rerank` are
 * background enrichment whose failure the caller absorbs, so they stay silent.
 *
 * That restriction is what makes one global channel sound. It is NOT true that only one request is
 * ever in flight — `useRankedSuggestions` fires `rankSuggestions` on a 500ms debounce, entirely
 * outside the copilot panel's `busy` gate. If that call published, its backoff would paint the
 * retry block over a chat turn that never made the request, and its ledger would land on the next
 * reply as a "Recovered after N attempts" line for attempts that turn never made. Keeping
 * background work on a non-`message` operation is the whole guarantee — do not widen it.
 */
export function subscribeToRetries(listener: (event: RetryEvent) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function publish(event: RetryEvent): void {
  for (const listener of [...listeners]) {
    listener(event);
  }
}

// ---------------------------------------------------------------------------
// The wrapper
// ---------------------------------------------------------------------------

/**
 * Combine an external stop signal with a per-attempt deadline. Hand-rolled rather than
 * `AbortSignal.any` so the wrapper runs unchanged under older runtimes (and under vitest on Node
 * 18). The deadline is per attempt, exactly as before the wrapper existed; the overall budget in
 * {@link RetryPolicy} is what stops three of them stacking into a six-minute wait.
 */
function linkSignals(
  deadlineMs: number,
  stop: AbortSignal,
): { signal: AbortSignal; dispose: () => void } {
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(new DOMException("The operation timed out.", "TimeoutError")),
    deadlineMs,
  );
  const onStop = () => controller.abort(new DOMException("Retrying was stopped.", "AbortError"));
  // Idempotent: runs from the abort listener on a timeout/stop, and from the caller's `finally`
  // on success. Without the latter, every successful request left a live timer for the full
  // per-attempt deadline — 300s on a local endpoint — plus a listener retained on the stopper.
  const dispose = () => {
    clearTimeout(timer);
    stop.removeEventListener("abort", onStop);
  };
  controller.signal.addEventListener("abort", dispose, { once: true });
  if (stop.aborted) {
    onStop();
  } else {
    stop.addEventListener("abort", onStop, { once: true });
  }
  return { signal: controller.signal, dispose };
}

/**
 * Backoff for a generation request. Three attempts is the ceiling: the copilot is interactive, and
 * a user staring at a spinner through four silent retries is worse than one honest error.
 */
export function messageRetryPolicy(
  attemptTimeoutMs: number,
  overrides: Partial<RetryPolicy> = {},
): RetryPolicy {
  return {
    maxAttempts: 3,
    // 2s then 4s, matching the ledger in the design reference. A `retry-after` overrides both.
    baseDelayMs: 2_000,
    maxDelayMs: 16_000,
    overallBudgetMs: attemptTimeoutMs * 2 + 30_000,
    attemptTimeoutMs,
    ...overrides,
  };
}

/**
 * Backoff for a background rerank. Same discipline as a model listing — the caller absorbs the
 * failure (it falls back to the deterministic suggestion order), so this must not spend a turn's
 * worth of budget on a nicety, and must never publish.
 */
export function rerankRetryPolicy(
  attemptTimeoutMs: number,
  overrides: Partial<RetryPolicy> = {},
): RetryPolicy {
  return {
    maxAttempts: 2,
    baseDelayMs: 1_000,
    maxDelayMs: 4_000,
    overallBudgetMs: attemptTimeoutMs + 8_000,
    attemptTimeoutMs,
    ...overrides,
  };
}

/**
 * Backoff for a model listing. Shorter and shallower than {@link messageRetryPolicy} on purpose:
 * `listModels()` throwing is the signal for callers to fall back to the static catalog, so a long
 * retry here only delays a fallback that was always going to happen.
 */
export function modelsRetryPolicy(
  attemptTimeoutMs: number,
  overrides: Partial<RetryPolicy> = {},
): RetryPolicy {
  return {
    maxAttempts: 2,
    baseDelayMs: 500,
    maxDelayMs: 2_000,
    overallBudgetMs: attemptTimeoutMs * 2 + 3_000,
    attemptTimeoutMs,
    ...overrides,
  };
}

/**
 * Run `attempt` under the policy, retrying the failures where retrying helps.
 *
 * `attempt` receives the signal it must pass to `fetch` — that is how Stop reaches an in-flight
 * request. It should throw a {@link ProviderError} for a non-OK response (see
 * {@link providerErrorFromResponse}); anything else it throws is classified here.
 *
 * The final error carries the whole attempt ledger, so the failure card can show what was tried
 * rather than only what failed last.
 */
export async function runWithRetry<T>(
  policy: RetryPolicy,
  context: RetryContext,
  attempt: (signal: AbortSignal) => Promise<T>,
  environment: RetryEnvironment = DEFAULT_ENVIRONMENT,
  random: () => number = Math.random,
): Promise<{ value: T; attempts: Attempt[]; elapsedMs: number }> {
  const started = environment.now();
  const attempts: Attempt[] = [];
  const stopper = new AbortController();
  const visible = context.operation === "message";

  for (let n = 1; ; n += 1) {
    let error: unknown;
    const link = linkSignals(policy.attemptTimeoutMs, stopper.signal);
    try {
      const value = await attempt(link.signal);
      const elapsedMs = environment.now() - started;
      if (visible && attempts.length > 0) {
        publish({ type: "settled", attempts, elapsedMs, stopped: false });
      }
      return { value, attempts, elapsedMs };
    } catch (thrown) {
      error = thrown;
    } finally {
      link.dispose();
    }

    // A stop is the user's decision, not a provider failure — it never becomes an error card.
    if (ProviderError.isStopped(error) && stopper.signal.aborted) {
      const elapsedMs = environment.now() - started;
      if (visible) {
        publish({ type: "settled", attempts, elapsedMs, stopped: true });
      }
      throw new RetryStoppedError(attempts, elapsedMs);
    }

    const failure = error instanceof ProviderError ? error.failure : classifyThrown(error, context);
    const requestId = error instanceof ProviderError ? error.requestId : undefined;
    const status =
      "status" in failure ? failure.status : failure.kind === "timeout" ? "timeout" : "transport";
    const record: Attempt = { n, status };
    attempts.push(record);

    const elapsed = environment.now() - started;
    const { waitMs, fromRetryAfter } = backoffMs(policy, n, failure, random);
    // The budget covers the wait *and* the attempt it would buy — starting an attempt that cannot
    // finish inside the budget just makes the user wait longer for the same failure.
    const fitsBudget = elapsed + waitMs + policy.attemptTimeoutMs <= policy.overallBudgetMs;
    const canRetry = isRetryable(failure) && n < attemptCap(policy, failure) && fitsBudget;

    if (!canRetry) {
      if (visible && attempts.length > 1) {
        publish({ type: "settled", attempts, elapsedMs: elapsed, stopped: false });
      }
      // Re-throw as a ProviderError carrying the ledger, so the card can show every attempt.
      const message =
        error instanceof ProviderError
          ? error.message
          : error instanceof Error
            ? error.message
            : String(error);
      throw new ProviderError(message, failure, context, attempts, requestId, elapsed);
    }

    record.waitedMs = waitMs;
    if (fromRetryAfter) {
      record.fromRetryAfter = true;
    }

    if (visible) {
      publish({
        type: "waiting",
        progress: {
          attempts: [...attempts],
          waitMs,
          nextAttemptAt: environment.now() + waitMs,
          maxAttempts: attemptCap(policy, failure),
          failure,
          context,
          stop: () => stopper.abort(new DOMException("Retrying was stopped.", "AbortError")),
        },
      });
    }

    await environment.wait(waitMs, stopper.signal);

    if (stopper.signal.aborted) {
      const stoppedAt = environment.now() - started;
      if (visible) {
        publish({ type: "settled", attempts, elapsedMs: stoppedAt, stopped: true });
      }
      throw new RetryStoppedError(attempts, stoppedAt);
    }

    // The wait is over and the next request is about to go out. Without this the panel keeps
    // rendering the backoff block — "Trying again in 0s", a spent countdown bar, a Cancel button
    // reading "Stop retrying" — for the entire duration of an attempt that is already in flight
    // (up to 120s hosted, 300s local). A loading state that says "waiting" while it is working is
    // the exact failure CLAUDE.md forbids.
    if (visible) {
      publish({ type: "attempting", attempt: n + 1, attempts: [...attempts] });
    }
  }
}
