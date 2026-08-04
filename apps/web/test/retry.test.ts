import { afterEach, describe, expect, it, vi } from "vitest";

import {
  type Attempt,
  ProviderError,
  type RetryContext,
  type RetryEnvironment,
  type RetryEvent,
  type RetryPolicy,
  RetryStoppedError,
  backoffMs,
  classifyResponse,
  classifyThrown,
  isRetryable,
  messageRetryPolicy,
  modelsRetryPolicy,
  providerErrorFromResponse,
  runWithRetry,
  subscribeToRetries,
} from "../src/ai/retry.js";
import { AnthropicBrowserProvider } from "../src/ai/AnthropicBrowserProvider.js";
import { LocalBrowserProvider } from "../src/ai/LocalBrowserProvider.js";
import type { Schema } from "@grafture/core";
import { COPILOT_RESPONSE_TOOL } from "../src/copilot/responseTool.js";

const EMPTY_SCHEMA: Schema = { tables: [], relationships: [] };

const ANTHROPIC: RetryContext = {
  label: "Anthropic",
  family: "anthropic",
  operation: "message",
  modelId: "claude-sonnet-4",
  attemptTimeoutMs: 120_000,
};

const LOCAL: RetryContext = {
  label: "Local",
  family: "local",
  operation: "message",
  modelId: "llama3.1",
  endpoint: "http://localhost:11434/v1",
};

/** A clock that only moves when the code under test waits. Keeps the suite free of real sleeps. */
function fakeEnvironment(): RetryEnvironment & { elapsed: () => number } {
  let clock = 0;
  return {
    now: () => clock,
    wait: async (ms) => {
      clock += ms;
    },
    elapsed: () => clock,
  };
}

const POLICY: RetryPolicy = {
  maxAttempts: 3,
  baseDelayMs: 2_000,
  maxDelayMs: 16_000,
  overallBudgetMs: 300_000,
  attemptTimeoutMs: 10_000,
};

/** No jitter, so expectations can name exact backoff values. */
const noJitter = () => 0.5;

function response(status: number, body: string, headers: Record<string, string> = {}): Response {
  return {
    ok: false,
    status,
    headers: new Headers(headers),
    text: async () => body,
  } as Response;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("classifyResponse", () => {
  it("reads a plain 429 as a rate limit and honours retry-after", () => {
    const failure = classifyResponse(429, "{}", new Headers({ "retry-after": "7" }), ANTHROPIC, 0);
    expect(failure).toEqual({ kind: "rate_limited", status: 429, retryAfterMs: 7000 });
  });

  it("accepts an HTTP-date retry-after too", () => {
    const now = Date.parse("2026-08-04T12:00:00Z");
    const failure = classifyResponse(
      429,
      "{}",
      new Headers({ "retry-after": "Tue, 04 Aug 2026 12:00:05 GMT" }),
      ANTHROPIC,
      now,
    );
    expect(failure).toEqual({ kind: "rate_limited", status: 429, retryAfterMs: 5000 });
  });

  it("reads insufficient_quota under a 429 as out of credit, NOT a rate limit", () => {
    // The trap: the status says retryable, the body says the account is permanently out of money.
    const body = JSON.stringify({ error: { type: "insufficient_quota", message: "no funds" } });
    const failure = classifyResponse(429, body, new Headers(), ANTHROPIC, 0);
    expect(failure).toEqual({ kind: "out_of_credit", status: 429 });
    expect(isRetryable(failure)).toBe(false);
  });

  it("also spots insufficient_quota reported under `code` rather than `type`", () => {
    const body = JSON.stringify({ error: { code: "insufficient_quota" } });
    expect(classifyResponse(429, body, new Headers(), ANTHROPIC, 0).kind).toBe("out_of_credit");
  });

  it("reads a 404 as an unknown model for a hosted provider", () => {
    expect(classifyResponse(404, "{}", new Headers(), ANTHROPIC, 0)).toEqual({
      kind: "unknown_model",
      status: 404,
      modelId: "claude-sonnet-4",
    });
  });

  it("reads the SAME 404 as an unreachable local runtime, because it is genuinely ambiguous", () => {
    // Wrong base URL or a model that was never pulled — JS cannot tell, so the card names both.
    expect(classifyResponse(404, "{}", new Headers(), LOCAL, 0)).toEqual({
      kind: "unreachable_local",
      endpoint: "http://localhost:11434/v1",
    });
  });

  it("reads a 400 whose body says the request was too long as too_large, not malformed", () => {
    // Several OpenAI-compatible runtimes report an oversized request as a 400. Calling that
    // "malformed" sends the user hunting for a typo that isn't there.
    const body = JSON.stringify({ error: { message: "This model's maximum context length is…" } });
    expect(classifyResponse(400, body, new Headers(), LOCAL, 0)).toEqual({
      kind: "too_large",
      status: 400,
    });
  });

  it("reads an ordinary 400 as malformed", () => {
    expect(
      classifyResponse(400, '{"error":{"type":"invalid_request_error"}}', undefined, ANTHROPIC, 0),
    ).toEqual({ kind: "malformed", status: 400 });
  });

  it("maps 401 and 403 to unauthorized, and 5xx to overloaded", () => {
    expect(classifyResponse(401, "", undefined, ANTHROPIC, 0).kind).toBe("unauthorized");
    expect(classifyResponse(403, "", undefined, ANTHROPIC, 0).kind).toBe("unauthorized");
    for (const status of [500, 502, 503, 504, 529]) {
      expect(classifyResponse(status, "", undefined, ANTHROPIC, 0)).toEqual({
        kind: "overloaded",
        status,
      });
    }
  });
});

describe("classifyThrown", () => {
  it("reads a TimeoutError DOMException as a timeout, not a transport failure", () => {
    const error = new DOMException("aborted", "TimeoutError");
    expect(classifyThrown(error, ANTHROPIC)).toEqual({ kind: "timeout" });
  });

  it("reads a bare fetch rejection as transport for a hosted provider", () => {
    expect(classifyThrown(new TypeError("Failed to fetch"), ANTHROPIC)).toEqual({
      kind: "transport",
    });
  });

  it("reads the same rejection as an unreachable local runtime for local", () => {
    expect(classifyThrown(new TypeError("Failed to fetch"), LOCAL)).toEqual({
      kind: "unreachable_local",
      endpoint: "http://localhost:11434/v1",
    });
  });
});

describe("isRetryable", () => {
  it("retries only a true rate limit and a server overload", () => {
    expect(isRetryable({ kind: "rate_limited", status: 429 })).toBe(true);
    expect(isRetryable({ kind: "overloaded", status: 529 })).toBe(true);
    for (const failure of [
      { kind: "out_of_credit", status: 429 },
      { kind: "unauthorized", status: 401 },
      { kind: "unknown_model", status: 404, modelId: "x" },
      { kind: "too_large", status: 413 },
      { kind: "malformed", status: 400 },
      { kind: "timeout" },
      { kind: "unreachable_local", endpoint: "e" },
      { kind: "transport" },
    ] as const) {
      expect(isRetryable(failure)).toBe(false);
    }
  });
});

describe("backoffMs", () => {
  it("doubles from the base and jitters within ±25%", () => {
    const failure = { kind: "overloaded", status: 529 } as const;
    expect(backoffMs(POLICY, 1, failure, noJitter)).toEqual({
      waitMs: 2000,
      fromRetryAfter: false,
    });
    expect(backoffMs(POLICY, 2, failure, noJitter)).toEqual({
      waitMs: 4000,
      fromRetryAfter: false,
    });
    // Jitter stays inside the stated band, so a fleet of clients doesn't return in lockstep.
    expect(backoffMs(POLICY, 1, failure, () => 0).waitMs).toBe(1500);
    expect(backoffMs(POLICY, 1, failure, () => 1).waitMs).toBe(2500);
  });

  it("caps the exponential at maxDelayMs", () => {
    const failure = { kind: "overloaded", status: 529 } as const;
    expect(backoffMs(POLICY, 8, failure, noJitter).waitMs).toBe(POLICY.maxDelayMs);
  });

  it("lets a provider's retry-after win outright, and flags the row as such", () => {
    // It's an instruction, not a suggestion — and the ledger annotates the row so the user can see
    // the wait was the provider's, not one we invented.
    const failure = { kind: "rate_limited", status: 429, retryAfterMs: 9000 } as const;
    expect(backoffMs(POLICY, 1, failure, noJitter)).toEqual({ waitMs: 9000, fromRetryAfter: true });
  });
});

describe("providerErrorFromResponse", () => {
  it("keeps the `{label} API error ({status})` message shape validateCredential parses", async () => {
    const error = await providerErrorFromResponse(response(401, '{"error":"nope"}'), ANTHROPIC);
    expect(error.message).toBe('Anthropic API error (401): {"error":"nope"}');
    expect(/\((401|403)\)/.test(error.message)).toBe(true);
    expect(error.failure).toEqual({ kind: "unauthorized", status: 401 });
  });

  it("uses the Models API surface for a listing call", async () => {
    const error = await providerErrorFromResponse(response(429, "{}"), {
      ...ANTHROPIC,
      operation: "models",
    });
    expect(error.message).toBe("Anthropic Models API error (429): {}");
  });

  it("preserves Anthropic's request_id — it is what their support traces on", async () => {
    const body = JSON.stringify({
      type: "error",
      error: { type: "overloaded_error" },
      request_id: "req_011CQ8vT2yPk4nZs",
    });
    const error = await providerErrorFromResponse(response(529, body), ANTHROPIC);
    expect(error.requestId).toBe("req_011CQ8vT2yPk4nZs");
  });
});

describe("runWithRetry", () => {
  it("returns the first success without waiting or recording an attempt", async () => {
    const environment = fakeEnvironment();
    const result = await runWithRetry(POLICY, ANTHROPIC, async () => "ok", environment, noJitter);
    expect(result).toEqual({ value: "ok", attempts: [], elapsedMs: 0 });
    expect(environment.elapsed()).toBe(0);
  });

  it("retries a 529 up to the cap, then throws with the full ledger", async () => {
    const environment = fakeEnvironment();
    const attempt = vi.fn(async () => {
      throw await providerErrorFromResponse(response(529, "{}"), ANTHROPIC);
    });

    const error = await runWithRetry(POLICY, ANTHROPIC, attempt, environment, noJitter).catch(
      (thrown: unknown) => thrown,
    );

    expect(attempt).toHaveBeenCalledTimes(3);
    expect(error).toBeInstanceOf(ProviderError);
    // The ledger is what the failure card shows: what was tried, not only what failed last.
    expect((error as ProviderError).attempts).toEqual([
      { n: 1, status: 529, waitedMs: 2000 },
      { n: 2, status: 529, waitedMs: 4000 },
      { n: 3, status: 529 },
    ] satisfies Attempt[]);
    expect((error as ProviderError).elapsedMs).toBe(6000);
  });

  it("recovers when a later attempt succeeds, and reports what it took", async () => {
    const environment = fakeEnvironment();
    let calls = 0;
    const result = await runWithRetry(
      POLICY,
      ANTHROPIC,
      async () => {
        calls += 1;
        if (calls < 3) {
          throw await providerErrorFromResponse(response(429, "{}"), ANTHROPIC);
        }
        return "recovered";
      },
      environment,
      noJitter,
    );
    expect(result.value).toBe("recovered");
    expect(result.attempts.map((a) => a.status)).toEqual([429, 429]);
    expect(result.elapsedMs).toBe(6000);
  });

  it("never retries insufficient_quota, even though its status is 429", async () => {
    const environment = fakeEnvironment();
    const body = JSON.stringify({ error: { type: "insufficient_quota" } });
    const attempt = vi.fn(async () => {
      throw await providerErrorFromResponse(response(429, body), ANTHROPIC);
    });

    await expect(
      runWithRetry(POLICY, ANTHROPIC, attempt, environment, noJitter),
    ).rejects.toBeInstanceOf(ProviderError);
    // A wrapper keyed only on status would hammer a dead account.
    expect(attempt).toHaveBeenCalledTimes(1);
    expect(environment.elapsed()).toBe(0);
  });

  it("never retries a timeout — the work may have completed server-side", async () => {
    const environment = fakeEnvironment();
    const attempt = vi.fn(async () => {
      throw new DOMException("timed out", "TimeoutError");
    });
    const error = await runWithRetry(POLICY, ANTHROPIC, attempt, environment, noJitter).catch(
      (thrown: unknown) => thrown,
    );
    expect(attempt).toHaveBeenCalledTimes(1);
    expect((error as ProviderError).failure).toEqual({ kind: "timeout" });
  });

  it("never retries a described local transport error — retrying a down server is pure latency", async () => {
    const environment = fakeEnvironment();
    const attempt = vi.fn(async () => {
      throw new Error("Couldn't reach a local model server at http://localhost:11434/v1.");
    });
    const error = await runWithRetry(POLICY, LOCAL, attempt, environment, noJitter).catch(
      (thrown: unknown) => thrown,
    );
    expect(attempt).toHaveBeenCalledTimes(1);
    expect((error as ProviderError).failure.kind).toBe("unreachable_local");
    // The guidance the local provider wrote is preserved verbatim, not replaced by the wrapper.
    expect((error as ProviderError).message).toMatch(/Couldn't reach a local model server/);
  });

  it("stops early when a non-retryable status arrives mid-backoff, keeping the earlier rows", async () => {
    const environment = fakeEnvironment();
    let calls = 0;
    const error = await runWithRetry(
      POLICY,
      ANTHROPIC,
      async () => {
        calls += 1;
        throw await providerErrorFromResponse(
          calls === 1 ? response(429, "{}") : response(401, "{}"),
          ANTHROPIC,
        );
      },
      environment,
      noJitter,
    ).catch((thrown: unknown) => thrown);

    expect(calls).toBe(2);
    // Without this ledger the user cannot tell an abandoned retry from a crash.
    expect((error as ProviderError).attempts).toEqual([
      { n: 1, status: 429, waitedMs: 2000 },
      { n: 2, status: 401 },
    ]);
    expect((error as ProviderError).failure).toEqual({ kind: "unauthorized", status: 401 });
  });

  it("honours a lower per-status cap (a local 500 is usually an OOM that reproduces)", async () => {
    const environment = fakeEnvironment();
    const attempt = vi.fn(async () => {
      throw await providerErrorFromResponse(response(500, "{}"), LOCAL);
    });
    await runWithRetry(
      { ...POLICY, maxAttemptsByStatus: { 500: 2 } },
      LOCAL,
      attempt,
      environment,
      noJitter,
    ).catch(() => undefined);
    expect(attempt).toHaveBeenCalledTimes(2);
  });

  it("stops when another attempt wouldn't fit the overall budget", async () => {
    // Per-attempt deadlines don't bound a retried call — three 120s attempts is a 360s worst case
    // — so the wrapper enforces its own ceiling.
    const environment = fakeEnvironment();
    const attempt = vi.fn(async () => {
      throw await providerErrorFromResponse(response(529, "{}"), ANTHROPIC);
    });
    const tight: RetryPolicy = { ...POLICY, attemptTimeoutMs: 10_000, overallBudgetMs: 11_000 };
    await runWithRetry(tight, ANTHROPIC, attempt, environment, noJitter).catch(() => undefined);
    // 0 elapsed + 2000 wait + 10000 next attempt = 12000 > 11000, so there is no second attempt.
    expect(attempt).toHaveBeenCalledTimes(1);
  });

  it("publishes waiting/settled for a message call so the panel can show the backoff", async () => {
    const environment = fakeEnvironment();
    const events: RetryEvent[] = [];
    const unsubscribe = subscribeToRetries((event) => events.push(event));
    let calls = 0;
    await runWithRetry(
      POLICY,
      ANTHROPIC,
      async () => {
        calls += 1;
        if (calls === 1) {
          throw await providerErrorFromResponse(
            response(429, "{}", { "retry-after": "3" }),
            ANTHROPIC,
          );
        }
        return "ok";
      },
      environment,
      noJitter,
    );
    unsubscribe();

    expect(events[0]?.type).toBe("waiting");
    const waiting = events[0] as Extract<RetryEvent, { type: "waiting" }>;
    expect(waiting.progress.waitMs).toBe(3000);
    expect(waiting.progress.attempts[0]?.fromRetryAfter).toBe(true);
    expect(events[1]).toEqual({
      type: "settled",
      attempts: [{ n: 1, status: 429, waitedMs: 3000, fromRetryAfter: true }],
      elapsedMs: 3000,
      stopped: false,
    });
  });

  it("stays silent for a models listing — its failure is a signal to fall back, not news", async () => {
    const environment = fakeEnvironment();
    const events: RetryEvent[] = [];
    const unsubscribe = subscribeToRetries((event) => events.push(event));
    await runWithRetry(
      POLICY,
      { ...ANTHROPIC, operation: "models" },
      async () => {
        throw await providerErrorFromResponse(response(529, "{}"), ANTHROPIC);
      },
      environment,
      noJitter,
    ).catch(() => undefined);
    unsubscribe();
    expect(events).toEqual([]);
  });

  it("Stop aborts the in-flight request and cancels the scheduled retry", async () => {
    // A stop that only cancelled the timer would leave a request in flight writing into a turn the
    // user has abandoned, so the attempt's own signal must be aborted too.
    const events: RetryEvent[] = [];
    const unsubscribe = subscribeToRetries((event) => {
      events.push(event);
      if (event.type === "waiting") {
        event.progress.stop();
      }
    });

    let sawAbort = false;
    const environment: RetryEnvironment = {
      now: () => 0,
      wait: async () => undefined,
    };
    const attempt = vi.fn(async (signal: AbortSignal) => {
      signal.addEventListener("abort", () => {
        sawAbort = true;
      });
      throw await providerErrorFromResponse(response(529, "{}"), ANTHROPIC);
    });

    const error = await runWithRetry(POLICY, ANTHROPIC, attempt, environment, noJitter).catch(
      (thrown: unknown) => thrown,
    );
    unsubscribe();

    expect(error).toBeInstanceOf(RetryStoppedError);
    expect(attempt).toHaveBeenCalledTimes(1);
    expect(sawAbort).toBe(true);
    expect(events.at(-1)).toMatchObject({ type: "settled", stopped: true });
  });
});

describe("retry policies", () => {
  it("caps generation at three attempts — a spinner through four silent retries is worse", () => {
    expect(messageRetryPolicy(120_000).maxAttempts).toBe(3);
  });

  it("keeps model-listing retries shorter, so the static-catalog fallback isn't delayed", () => {
    const models = modelsRetryPolicy(15_000);
    const message = messageRetryPolicy(120_000);
    expect(models.maxAttempts).toBeLessThan(message.maxAttempts);
    expect(models.baseDelayMs).toBeLessThan(message.baseDelayMs);
    expect(models.maxDelayMs).toBeLessThan(message.maxDelayMs);
  });
});

// ---------------------------------------------------------------------------
// Provider-level wiring
// ---------------------------------------------------------------------------

/** Stub `fetch` with a queue of responses; the last one repeats. */
function stubFetch(responses: Response[]) {
  let i = 0;
  const fetchMock = vi.fn(async () => {
    const next = responses[Math.min(i, responses.length - 1)]!;
    i += 1;
    return next;
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

const okAnthropic = {
  ok: true,
  json: async () => ({
    content: [
      {
        type: "tool_use",
        name: COPILOT_RESPONSE_TOOL.name,
        input: { reply: "ok", actions: [], status: "complete" },
      },
    ],
  }),
} as Response;

/** Zero delays so provider-level retry paths are exercised without real sleeps. */
const INSTANT = {
  message: { baseDelayMs: 0, maxDelayMs: 0 },
  models: { baseDelayMs: 0, maxDelayMs: 0 },
};

describe("AnthropicBrowserProvider retry wiring", () => {
  it("retries an overloaded generation and succeeds", async () => {
    const fetchMock = stubFetch([response(529, "{}"), okAnthropic]);
    const provider = new AnthropicBrowserProvider(
      "sk-ant-test",
      "claude-sonnet-4",
      "postgres",
      INSTANT,
    );
    const result = await provider.propose(EMPTY_SCHEMA, [], "hi");
    expect(result.reply).toBe("ok");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("surfaces a 401 immediately, classified, with the parseable message intact", async () => {
    const fetchMock = stubFetch([response(401, '{"error":{"type":"authentication_error"}}')]);
    const provider = new AnthropicBrowserProvider(
      "sk-ant-bad",
      "claude-sonnet-4",
      "postgres",
      INSTANT,
    );
    const error = await provider.propose(EMPTY_SCHEMA, [], "hi").catch((e: unknown) => e);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(error).toBeInstanceOf(ProviderError);
    expect((error as ProviderError).failure).toEqual({ kind: "unauthorized", status: 401 });
    expect((error as ProviderError).message).toMatch(/\(401\)/);
  });

  it("retries a models page rather than the whole listing", async () => {
    // Retry at the fetch level is the correct granularity: a transient failure on page 2 must not
    // re-fetch page 1.
    const page1 = {
      ok: true,
      json: async () => ({
        data: [{ id: "claude-opus-5" }],
        has_more: true,
        last_id: "claude-opus-5",
      }),
    } as Response;
    const page2 = {
      ok: true,
      json: async () => ({ data: [{ id: "claude-sonnet-5" }], has_more: false }),
    } as Response;
    const fetchMock = stubFetch([page1, response(529, "{}"), page2]);
    const provider = new AnthropicBrowserProvider(
      "sk-ant-test",
      "claude-sonnet-4",
      "postgres",
      INSTANT,
    );
    const models = await provider.listModels();
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(models.map((m) => m.id)).toEqual(["claude-opus-5", "claude-sonnet-5"]);
  });
});

describe("LocalBrowserProvider retry wiring", () => {
  it("gives a local 500 one retry, not two", async () => {
    const fetchMock = stubFetch([response(500, "boom")]);
    const provider = new LocalBrowserProvider(
      "http://localhost:11434/v1",
      "llama3.1",
      "postgres",
      INSTANT,
    );
    await provider.propose(EMPTY_SCHEMA, [], "go").catch(() => undefined);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("classifies a transport failure as an unreachable local runtime, and does not retry it", async () => {
    const fetchMock = vi.fn(async () => {
      throw new TypeError("Failed to fetch");
    });
    vi.stubGlobal("fetch", fetchMock);
    const provider = new LocalBrowserProvider(
      "http://localhost:11434/v1",
      "llama3.1",
      "postgres",
      INSTANT,
    );
    const error = await provider.propose(EMPTY_SCHEMA, [], "go").catch((e: unknown) => e);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect((error as ProviderError).failure).toEqual({
      kind: "unreachable_local",
      endpoint: "http://localhost:11434/v1",
    });
  });
});
