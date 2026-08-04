import { describe, expect, it } from "vitest";

import type { Attempt } from "../src/ai/retry.js";
import {
  type CausePart,
  type CopilotFailure,
  describeFailure,
  endpointLabel,
  failurePhase,
  interruptedCause,
  runtimeCommand,
  toProviderFailure,
} from "../src/copilot/failureCopy.js";

/** Flatten cause segments to plain text for assertions. */
function text(parts: CausePart[]): string {
  return parts.map((part) => (typeof part === "string" ? part : part.mono)).join("");
}

function detail(overrides: Partial<CopilotFailure> = {}): CopilotFailure {
  return {
    failure: { kind: "overloaded", status: 529 },
    providerLabel: "Anthropic",
    providerId: "anthropic",
    ...overrides,
  };
}

const THREE_529s: Attempt[] = [
  { n: 1, status: 429, waitedMs: 2000, fromRetryAfter: true },
  { n: 2, status: 529, waitedMs: 4000 },
  { n: 3, status: 529 },
];

describe("describeFailure — severity", () => {
  it("marks a dead turn fatal and a one-step-away turn fixable", () => {
    // The split is the whole point: red means stop reading and do something else; amber means one
    // control away from working. Collapsing them would erase the only signal that distinguishes
    // "your key is revoked" from "pick a different model".
    const fatal = [
      { kind: "overloaded", status: 529 },
      { kind: "out_of_credit", status: 429 },
      { kind: "unauthorized", status: 401 },
      { kind: "malformed", status: 400 },
    ] as const;
    for (const failure of fatal) {
      expect(describeFailure(detail({ failure })).severity).toBe("fatal");
    }

    const fixable = [
      { kind: "unknown_model", status: 404, modelId: "claude-3-opus-20240229" },
      { kind: "too_large", status: 413 },
      { kind: "timeout" },
      { kind: "unreachable_local", endpoint: "http://localhost:11434/v1" },
      { kind: "transport" },
    ] as const;
    for (const failure of fixable) {
      expect(describeFailure(detail({ failure })).severity).toBe("fixable");
    }
  });
});

describe("describeFailure — copy rules", () => {
  it("names the actor rather than saying something went wrong", () => {
    expect(describeFailure(detail({ providerLabel: "Anthropic" })).title).toBe(
      "Anthropic is at capacity",
    );
    expect(
      describeFailure(
        detail({ providerLabel: "OpenAI", failure: { kind: "overloaded", status: 503 } }),
      ).title,
    ).toBe("OpenAI is at capacity");
  });

  it("keeps titles free of exclamation marks, apology, and a terminal period", () => {
    const failures = [
      { kind: "overloaded", status: 529 },
      { kind: "out_of_credit", status: 429 },
      { kind: "unauthorized", status: 401 },
      { kind: "unauthorized", status: 403 },
      { kind: "unknown_model", status: 404, modelId: "m" },
      { kind: "too_large", status: 413 },
      { kind: "malformed", status: 400 },
      { kind: "timeout" },
      { kind: "unreachable_local", endpoint: "http://localhost:11434/v1" },
      { kind: "transport" },
      { kind: "rate_limited", status: 429 },
    ] as const;
    for (const failure of failures) {
      const copy = describeFailure(detail({ failure }));
      expect(copy.title).not.toMatch(/[!.]$/);
      expect(copy.title.toLowerCase()).not.toMatch(/oops|sorry|apolog/);
      expect(text(copy.cause)).not.toMatch(/!/);
      // At most two actions: the one that resolves the cause, and Dismiss (added by the component).
      expect(copy.primary === null || typeof copy.primary.label === "string").toBe(true);
    }
  });

  it("owns a malformed request as ours rather than implying the user typed something wrong", () => {
    const copy = describeFailure(detail({ failure: { kind: "malformed", status: 400 } }));
    expect(text(copy.cause)).toMatch(/Grafture's fault, not yours/);
  });

  it("interpolates the measured attempt count and elapsed time, not round stand-ins", () => {
    const copy = describeFailure(detail({ attempts: THREE_529s, elapsedMs: 14_200 }));
    expect(text(copy.cause)).toBe(
      "Nothing about the request is wrong — three attempts over 14s all came back overloaded.",
    );
  });

  it("does not claim multiple attempts when the first failure was fatal", () => {
    const copy = describeFailure(detail({ attempts: [{ n: 1, status: 529 }], elapsedMs: 0 }));
    expect(text(copy.cause)).not.toMatch(/attempts over/);
  });

  it("names the real model id in the stale-preference card", () => {
    const copy = describeFailure(
      detail({
        failure: { kind: "unknown_model", status: 404, modelId: "claude-3-opus-20240229" },
      }),
    );
    expect(copy.title).toBe("That model isn't on this key");
    expect(text(copy.cause)).toBe(
      "Your saved choice claude-3-opus-20240229 is no longer in the catalog.",
    );
    // The id renders in mono, which is why the cause is segments rather than a string.
    expect(copy.cause).toContainEqual({ mono: "claude-3-opus-20240229" });
  });

  it("uses the real timeout in the timeout card", () => {
    const copy = describeFailure(detail({ failure: { kind: "timeout" }, timeoutMs: 120_000 }));
    expect(copy.title).toBe("No response after 120s");
    expect(copy.statusLabel).toBe("timeout");
    // A re-send after a timeout is a coin flip, so it gets no purple button.
    expect(copy.weakPrimary).toBe(true);
  });

  it("counts the actual sources in the too-large card", () => {
    const copy = describeFailure(
      detail({ failure: { kind: "too_large", status: 413 }, sourceCount: 6 }),
    );
    expect(text(copy.cause)).toBe(
      "Six sources with wide sample values pushed the prompt past the limit — narrow the scope and it'll go through.",
    );
  });

  it("separates a 401 (bad key) from a 403 (no access to that model)", () => {
    const rejected = describeFailure(detail({ failure: { kind: "unauthorized", status: 401 } }));
    expect(rejected.title).toBe("Anthropic rejected this key");
    expect(rejected.primary).toEqual({ id: "connect", label: "Update key" });

    const forbidden = describeFailure(
      detail({ failure: { kind: "unauthorized", status: 403 }, modelId: "claude-opus-5" }),
    );
    expect(forbidden.title).toBe("Anthropic refused this key for that model");
    expect(forbidden.primary).toEqual({ id: "pick-model", label: "Choose a model" });
  });

  it("says a quota limit is not a rate limit, and never offers a retry for it", () => {
    const copy = describeFailure(
      detail({ providerLabel: "OpenAI", failure: { kind: "out_of_credit", status: 429 } }),
    );
    expect(copy.title).toBe("This OpenAI account is out of credit");
    expect(text(copy.cause)).toMatch(/retrying won't clear it/);
    expect(copy.primary?.id).not.toBe("retry");
  });
});

describe("describeFailure — the status slot", () => {
  it("always shows the real code, never a friendlier invented one", () => {
    expect(
      describeFailure(detail({ failure: { kind: "overloaded", status: 529 } })).statusLabel,
    ).toBe("529");
    expect(
      describeFailure(detail({ failure: { kind: "malformed", status: 422 } })).statusLabel,
    ).toBe("422");
  });

  it("shows the endpoint instead of a code for a local runtime, where the endpoint is the identifier", () => {
    const copy = describeFailure(
      detail({
        providerId: "local",
        providerLabel: "Local",
        failure: { kind: "unreachable_local", endpoint: "http://localhost:11434/v1" },
      }),
    );
    expect(copy.statusLabel).toBe("localhost:11434");
  });
});

describe("the local-runtime card", () => {
  it("names both causes rather than guessing which one it is", () => {
    const copy = describeFailure(
      detail({
        providerId: "local",
        providerLabel: "Local",
        failure: { kind: "unreachable_local", endpoint: "http://localhost:11434/v1" },
      }),
    );
    expect(copy.bullets).toEqual([
      "The server isn't running.",
      "It's running but refusing this origin (CORS).",
    ]);
    expect(copy.primary).toEqual({ id: "test-connection", label: "Test connection" });
  });

  it("picks the command from the runtime the port implies, and prints none when there isn't one", () => {
    // The Ollama form is a default, not the only case; printing it at an LM Studio user is worse
    // than printing nothing.
    expect(runtimeCommand("http://localhost:11434/v1")).toBe("OLLAMA_ORIGINS=* ollama serve");
    expect(runtimeCommand("http://localhost:8080/v1")).toMatch(/llama-server/);
    expect(runtimeCommand("http://localhost:1234/v1")).toBeUndefined();
  });

  it("reduces the endpoint to its host", () => {
    expect(endpointLabel("http://localhost:11434/v1")).toBe("localhost:11434");
    expect(endpointLabel("not a url")).toBe("not a url");
  });
});

describe("failurePhase", () => {
  it("calls a retried-out failure exhausted", () => {
    expect(failurePhase(detail({ attempts: THREE_529s }))).toBe("exhausted");
  });

  it("calls a retry cut short by a new, non-retryable status interrupted", () => {
    // Without this state the user cannot tell an abandoned retry from a crash.
    const stopped = detail({
      failure: { kind: "unauthorized", status: 401 },
      attempts: [
        { n: 1, status: 429, waitedMs: 2000, fromRetryAfter: true },
        { n: 2, status: 401 },
      ],
    });
    expect(failurePhase(stopped)).toBe("interrupted");
    expect(text(interruptedCause(stopped))).toBe(
      "The second attempt came back refused rather than rate limited, so retrying stopped there.",
    );
  });

  it("calls a first-try failure immediate", () => {
    expect(failurePhase(detail({ failure: { kind: "unauthorized", status: 401 } }))).toBe(
      "immediate",
    );
  });
});

describe("toProviderFailure", () => {
  it("accepts every kind this build draws a card for", () => {
    expect(toProviderFailure({ kind: "overloaded", status: 529 })).toEqual({
      kind: "overloaded",
      status: 529,
    });
  });

  it("rejects a kind from a newer build, so the raw message is shown instead of a guessed cause", () => {
    expect(toProviderFailure({ kind: "content_filtered", status: 451 })).toBeNull();
  });
});
