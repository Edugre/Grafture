# AI provider error codes

Reference for the failures the BYO-key providers in `apps/web/src/ai/` can surface, what
each one means, and which are worth retrying. Written as input for a retry/backoff wrapper;
that wrapper now exists in **`apps/web/src/ai/retry.ts`**, and this file remains its
behavioural source of truth — every classification decision there traces to a row below.

The sections that follow describe the wire behaviour of the providers, which the wrapper
reads; they are not a description of the wrapper itself. For what the user sees when one of
these failures reaches the transcript, see `apps/web/src/copilot/failureCopy.ts`.

Two provider families:

| Family            | Class                             | Endpoints                                                                                |
| ----------------- | --------------------------------- | ---------------------------------------------------------------------------------------- |
| Anthropic         | `AnthropicBrowserProvider`        | `POST https://api.anthropic.com/v1/messages`, `GET /v1/models`                           |
| OpenAI-compatible | `OpenAiCompatibleProvider` (base) | `{chatUrl}`, `{modelsUrl}` from config                                                   |
| ↳ hosted          | `OpenAiBrowserProvider`           | `https://api.openai.com/v1/chat/completions`, `/v1/models`                               |
| ↳ local           | `LocalBrowserProvider`            | `{endpoint}/chat/completions`, `{endpoint}/models` (default `http://localhost:11434/v1`) |

---

## How a failure is reported

On a non-OK response the body is read as text and thrown as a `ProviderError` whose message
embeds the label and the HTTP status, exactly as the bare `Error` did before the wrapper
existed:

```
Anthropic API error (529): {"type":"error","error":{"type":"overloaded_error",...}}
Anthropic Models API error (401): {...}
OpenAI API error (429): {...}
Local Models API error (404): {...}
```

Built in one place — `providerErrorFromResponse` in `retry.ts` — from the `RetryContext` each
provider supplies. The `{label} API error ({status})` shape takes its label from
`OpenAiCompatibleConfig.errorLabel` (`"OpenAI"` or `"Local"`), and `Models API` replaces `API`
when the failing call was a model listing.

> **The `(NNN)` in the message is load-bearing.** `validateCredential.ts` matched
> `/\((401|403)\)/` against the thrown message to tell a rejected key from an unreachable
> server. It now reads `ProviderError.failure` instead — reading a type beats re-parsing a
> string we also produce — but the substring is still emitted, because anything thrown outside
> the wrapper falls back to that regex.

Alongside the message, `providerErrorFromResponse` attaches a typed `ProviderFailure`. That is
what the copilot branches on: a 400 and a 529 now produce different cards, different severities,
and different actions, where before both were thrown and rendered as the same raw string.

---

## Anthropic status codes

`POST /v1/messages` and `GET /v1/models`. Body is JSON:
`{"type":"error","error":{"type":"...","message":"..."},"request_id":"req_..."}`.

| Status | `error.type`            | Retryable | Cause in this app                                                                                                                                             |
| ------ | ----------------------- | --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 400    | `invalid_request_error` | No        | Malformed request. Most likely ours, not the user's — bad tool schema, unsupported param for the selected model, oversized system prompt.                     |
| 401    | `authentication_error`  | No        | Missing/revoked/typo'd API key. Surfaced by `validateCredentialLive` as `reason: "rejected"`.                                                                 |
| 403    | `permission_error`      | No        | Key lacks access to the selected model, or an org-level restriction. Also `reason: "rejected"`.                                                               |
| 404    | `not_found_error`       | No        | Bad model id. Reachable when a saved model preference outlives a catalog refresh.                                                                             |
| 413    | `request_too_large`     | No        | Request body over the limit. Realistic here: the detector block plus a large schema plus wide sample values. Trim, don't retry.                               |
| 429    | `rate_limit_error`      | **Yes**   | RPM/TPM/TPD exceeded. Honour the `retry-after` response header when present.                                                                                  |
| 500    | `api_error`             | **Yes**   | Anthropic-side fault. Back off.                                                                                                                               |
| 529    | `overloaded_error`      | **Yes**   | Anthropic at capacity. Nothing about the request is wrong; the same bytes usually succeed seconds later. Back off; check status.anthropic.com if it persists. |

Notes for a wrapper:

- Only 429 carries a meaningful `retry-after`; treat it as advisory elsewhere.
- The `request_id` in the body is worth preserving in the surfaced message — it is what
  Anthropic support traces on.
- `listModels()` paginates, so the retry policy is applied around each page's `fetch` rather than
  the whole listing: a transient 529 on page 3 must not re-fetch pages 1 and 2.

---

## OpenAI-compatible status codes

Hosted OpenAI and every local runtime share `openaiCompatible.ts`, so they share the failure
path — but not the failure _vocabulary_. Local runtimes (Ollama, LM Studio, llama.cpp, vLLM)
implement the OpenAI surface loosely and their status codes vary.

| Status          | Retryable | Hosted OpenAI                                                                                                                    | Local runtime                                                                                                                                                             |
| --------------- | --------- | -------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 400             | No        | Malformed request; unsupported param for the model.                                                                              | Frequently also "model not loaded" or an unsupported field the runtime chose to reject rather than ignore.                                                                |
| 401             | No        | Bad/revoked key. `reason: "rejected"`.                                                                                           | Only if the runtime was started with auth. Default is keyless (`authHeaders: () => ({})`).                                                                                |
| 403             | No        | Org/region restriction.                                                                                                          | Rare.                                                                                                                                                                     |
| 404             | No        | Unknown model id or wrong URL.                                                                                                   | **Common and ambiguous**: wrong base URL (missing `/v1`), or the endpoint exists but the model was never pulled.                                                          |
| 413             | No        | Body too large.                                                                                                                  | Some runtimes return 400 instead.                                                                                                                                         |
| 422             | No        | Schema validation failure on a structured request.                                                                               | Runtime-dependent.                                                                                                                                                        |
| 429             | **Yes**   | Rate or quota limit. Distinguish `insufficient_quota` (**not** retryable — the account is out of credit) from a true rate limit. | Rare; some runtimes use it for "server busy", which _is_ retryable.                                                                                                       |
| 500             | **Yes**   | Server fault.                                                                                                                    | Often a genuine model crash (OOM). Retrying an OOM reproduces it — cap attempts low.                                                                                      |
| 502 / 503 / 504 | **Yes**   | Gateway/capacity.                                                                                                                | A reverse proxy in front of a local runtime, or the runtime still loading a large model into memory. 503-while-loading is the one local case where retry genuinely helps. |

`insufficient_quota` under a 429 is the trap: the status says "retryable", the body says
"permanently out of money". A wrapper that keys only on status will hammer a dead account.

---

## Transport errors (no HTTP status at all)

A rejected `fetch` never reaches the status check.

- **Anthropic / OpenAI**: the raw rejection propagates. In a browser that is
  `TypeError: Failed to fetch` — DNS failure, offline, or a CORS block. Not retryable in a way
  that helps within one turn, though a single delayed retry covers a transient network blip.
- **Local**: routed through `describeTransportError` (`LocalBrowserProvider.ts`) and rewritten
  into setup guidance — server not running vs. CORS refusal, which JS cannot distinguish. That
  rewrite deliberately skips `DOMException` so timeouts still bubble as themselves. A retry
  wrapper must preserve this: retrying a "your server isn't running" error is pure latency.

### Timeouts

Each request carries `AbortSignal.timeout(...)`. Exceeding it rejects with a `DOMException`
(`name: "TimeoutError"`), not an HTTP status.

| Provider  | Chat/messages | Models listing |
| --------- | ------------- | -------------- |
| Anthropic | 120 s         | 15 s           |
| OpenAI    | 120 s         | 15 s           |
| Local     | 300 s         | 10 s           |

The local generation deadline is intentionally long — CPU inference on a laptop can take
minutes (`LocalBrowserProvider.ts`). Treat a timeout as **not** retryable by default: the
work may have partially happened server-side, and a retry doubles an already-long wait.

---

## Retryability summary

Retry with jittered exponential backoff: **429** (except `insufficient_quota`), **500**, **502**,
**503**, **504**, **529**.

Fail fast: **400**, **401**, **403**, **404**, **413**, **422**, transport errors with a
described cause, and timeouts.

Honour `retry-after` when present; otherwise back off from a small base. Cap attempts — the
copilot is interactive, and a user staring at a spinner through four silent retries is worse
than one honest error.

## Behaviour the wrapper must not break

1. The `{label} API error ({status})` message shape — `validateCredential.ts` falls back to it.
2. `describeTransportError` rewriting for local (`openaiCompatible.ts`, `fetchOrDescribe`).
3. `AbortSignal.timeout` deadlines are per attempt, not per call — a 3-attempt retry of a
   120 s request has a 360 s worst case unless the wrapper enforces its own overall budget.
   `RetryPolicy.overallBudgetMs` is that budget; an attempt that cannot finish inside it is
   never started.
4. `listModels()` throwing is the signal for callers to fall back to the static catalog. Retry
   delays that fallback, so `modelsRetryPolicy` is deliberately shorter and shallower than
   `messageRetryPolicy`, and a model-listing retry publishes nothing to the UI.
