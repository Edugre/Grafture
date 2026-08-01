# Gap — nothing guards copilot rationale quality

Status: **open**. Not a defect in shipped behaviour; a missing regression guard.
Context: `docs/provenance-and-rationale-plan.md` (PR-1…PR-7, branch `feat/schema-provenance-rationale`).

## The gap

The rationale feature's value depends on the copilot actually doing three things, none of which any
automated test checks:

1. emitting `rationale` **before** the decision fields (the autoregressive ordering that makes it
   reasoning rather than post-hoc justification);
2. citing a **measured figure** — containment %, distinct/non-empty counts, an inferred grain, a
   detector verdict — instead of restating the action in words;
3. **staying in scope** — no rationale on the mechanical ops, or on a routine `set_type`.

All three live entirely in `RATIONALE_GUIDANCE` in `apps/web/src/copilot/systemPrompt.ts`. The
existing tests assert that the guidance **is in the prompt**, not that the model **follows** it.

So an edit to that prompt — or a model change — can quietly degrade rationale quality to plausible
filler with the full suite still green. Compliance was confirmed once, by a manual live run on
2026-08-01, and nothing re-checks it.

## Why it was left open

Verifying it needs a live model call, which needs `ANTHROPIC_API_KEY` and costs money and time, so
it cannot run in CI. The project already has the right home for exactly this trade-off:
`apps/web/test/evals.live.test.ts` is opt-in via the key and skipped otherwise.

## Where to fix it

`apps/web/test/evals.live.test.ts`. It already drives a real `propose()` over a flattened orders
CSV and asserts structural properties. Add rationale assertions to the same call — no new fixture,
no extra request.

**Trap to avoid:** the existing test calls

```ts
applyActions(emptySchema(), result.actions);
```

with **no `actor`**, so it defaults to `"user"` — which means `applyActions` _drops every
rationale_. Assert against the raw `result.actions`, or pass `{ actor: "ai" }`. Reading provenance
off the schema built by that existing call would show no rationales and look like total
non-compliance.

## Sketch

```ts
const NEEDS_RATIONALE = new Set(["add_relationship", "set_cardinality", "set_pk"]);
const NEVER_RATIONALE = new Set([
  "add_field",
  "remove_field",
  "remove_table",
  "rename_table",
  "rename_field",
  "remove_relationship",
]);

const actions = result.actions as Array<Record<string, unknown>>;
const required = actions.filter((a) => NEEDS_RATIONALE.has(String(a["op"])));

// The prompt should have produced at least one judgment call to explain.
expect(required.length).toBeGreaterThan(0);

for (const action of required) {
  const rationale = action["rationale"] as { text?: string; evidence?: string[] } | undefined;
  expect(rationale?.text, `no rationale on ${String(action["op"])}`).toBeTruthy();

  // Cites something measured rather than restating the action. A digit is a crude proxy for
  // "looked at the data" — deliberately loose, since the wording is the model's to choose.
  expect(/\d/.test(rationale?.text ?? ""), `no figure cited: ${rationale?.text}`).toBe(true);

  // Ordering: `rationale` must precede the decision fields. This is the ONLY place the ordering
  // is observable — it is gone by the time the action reaches the store.
  const keys = Object.keys(action);
  expect(keys.indexOf("rationale")).toBeLessThan(keys.indexOf("op"));
}

// Scope: mechanical ops must stay bare, or every turn pays output tokens for noise.
for (const action of actions.filter((a) => NEVER_RATIONALE.has(String(a["op"])))) {
  expect(action["rationale"], `unexpected rationale on ${String(action["op"])}`).toBeUndefined();
}
```

Two caveats on the sketch:

- **Key order survives `JSON.parse`** for distinct non-numeric keys, so reading `Object.keys` off
  the parsed tool input is sound — but it is the only surviving trace. If the provider layer ever
  normalises or rebuilds action objects, this assertion silently stops testing anything, so it is
  worth a comment at the assertion site.
- **The digit check is a proxy, not a judge.** It catches "linking orders to customers because
  orders belong to customers" and passes anything with a number in it. Tightening it into a real
  quality bar would mean an LLM-as-judge pass, which is a larger change and probably not worth it.

## Running it

```
ANTHROPIC_API_KEY=sk-... pnpm --filter @grafture/web exec vitest run test/evals.live.test.ts
```

Worth running whenever `RATIONALE_GUIDANCE` changes, the response tool's `actions` description
changes, or the default model changes.
