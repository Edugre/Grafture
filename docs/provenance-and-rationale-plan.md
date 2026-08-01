# Plan — Schema provenance + AI rationale

Branch: `feat/schema-provenance-rationale`

## Goal

Two related but separate capabilities:

1. **Provenance** — every field and relationship records who created it (`ai | user | imported`)
   and whether it has been modified since. Rendered on the canvas so a user can see at a glance
   which parts of the schema the copilot proposed and which parts they own.
2. **Rationale** — for AI-created relationships, cardinalities, and PK/type decisions, the copilot
   records _why_, citing the evidence it used. Frozen at write time, marked stale when the entity
   it describes is edited.

The reasoning gain comes from rationale being emitted **before** the decision it justifies and
being **required to cite computed evidence** — not from the field merely existing.

## Design decisions (and the reasons)

### Provenance is two orthogonal bits, not one enum

`origin` is set once at creation and never changes. `touched` flips false→true on the first
modification and never flips back. A single `ai_generated | user_written` enum cannot express
"AI table, one field renamed by hand" or "user table, copilot added a field" — both of which happen
constantly. Two bits give four states, all meaningful:

| origin | touched | meaning                                    | rationale shown |
| ------ | ------- | ------------------------------------------ | --------------- |
| ai     | false   | as proposed by the copilot                 | live            |
| ai     | true    | copilot proposal, since edited by the user | stale, retained |
| user   | false   | hand-authored                              | none            |
| user   | true    | hand-authored, since edited by the copilot | none            |

`ai + touched` retains the rationale rather than deleting it: the gap between what the AI claimed
and what the user changed is the interesting part.

**Implemented rule (revised during PR-1):** `touched` flips when the acting party differs from the
entity's `origin` — not the narrower "user edits an AI entity" first drafted. The general rule
subsumes the narrow one, makes all four rows above reachable, and states the actual invariant: the
copilot revising its _own_ proposal leaves the rationale true, so that must not mark it stale.

### Granularity: each entity owns its own attributes

Provenance sits on tables, fields, **and** relationships — but it only ever describes that entity's
own attributes. A table's provenance covers its **name**; a field's covers that field. So a
hand-renamed field marks only that field, and the table keeps its AI origin along with every
still-valid rationale on its siblings.

"Is this table AI-generated overall?" stays **derived** from its fields at render time and is never
stored — that derived rollup is what the earlier draft meant by "not table," and it still holds.
The correction found in PR-1: `rename_table` is a real mutation with no field to record it against,
so without table-level provenance a user renaming an AI table would leave no trace at all.

### `description` is not `rationale`

- **`description`** — semantic, human-editable by anyone regardless of origin, belongs in the
  domain model, exports as `COMMENT ON TABLE` / `COMMENT ON COLUMN`. Out of scope for this branch;
  noted so the two are not conflated later.
- **`rationale`** — AI-only, immutable, evidence-citing, staleable provenance. In scope.

Not coupling them is what lets a user-edited AI relationship still carry its original rationale.

### Core cannot infer the actor

Per `CLAUDE.md` and confirmed in `apps/web/src/store/schemaStore.ts`, manual edits and AI output
**both** flow through `applyActions`. So `applyActions` has no way to tell who acted, and must not
guess. The actor is passed in as an option; the store supplies it (`"user"` from UI commands,
`"ai"` from `runActions` on the copilot path).

### Provenance must live where history already snapshots

`StoreSnapshot` in `apps/web/src/store/history.ts` clones `schema` and aliases `sources`. Anything
outside `schema` is invisible to undo/redo. Two options:

- **(A) In the domain model** — `provenance?: Provenance` on `Field` and `Relationship`. Undo/redo
  and project persistence work with zero extra plumbing, because they already carry `schema`.
- **(B) Side table in `StoreSnapshot`** — keeps `SchemaSchema` clean but requires adding a third
  key to the snapshot, extending `cloneSnapshot`, and keeping ids in sync through every
  add/remove.

**Recommend (A)**, optional field. It survives export/import for free, and the field is optional so
existing schemas and every current test stay valid. The earlier concern about polluting the domain
contract is outweighed by the correctness risk in (B): a side table that drifts out of sync on
cascade deletes (`removeRelationshipsForTable`, `removeRelationshipsForField`) is a real bug class,
and undo correctness is a hard rule in `CLAUDE.md`.

## Data model

`packages/core/src/model.ts`:

```ts
export const OriginSchema = z.enum(["ai", "user", "imported"]);

export const RationaleSchema = z.object({
  /** Why this was proposed. Written before the decision it justifies. */
  text: z.string(),
  /** Evidence the copilot cited: detector finding ids, probe results. */
  evidence: z.array(z.string()).default([]),
  /** Copilot turn that produced it, for grouping in the review panel. */
  turnId: z.string().optional(),
});

export const ProvenanceSchema = z.object({
  origin: OriginSchema,
  touched: z.boolean().default(false),
  rationale: RationaleSchema.optional(),
});
```

Added as `provenance: ProvenanceSchema.optional()` to `TableSchema`, `FieldSchema`, and
`RelationshipSchema`. Absent provenance renders as `user` — no migration needed for existing
projects, and every pre-existing test stays valid.

## Work breakdown

### PR-1 — core: model + provenance-aware `applyActions` — **DONE**

- Added `OriginSchema` / `RationaleSchema` / `ProvenanceSchema` to `model.ts`, exported from
  `index.ts`. `RationaleSchema` exists but nothing writes it yet — that is PR-2.
- `ApplyActionsOptions` gained `actor?: Origin` (default `"user"`: an unattributed edit is the
  user's, which is the safe reading).
- Creating ops (`add_table` — table _and_ its fields, `add_field`, `add_relationship`) stamp
  `{ origin: actor, touched: false }`.
- Mutating ops (`rename_table`, `rename_field`, `set_type`, `set_pk`, `set_cardinality`) call
  `markTouched`, which flips `touched` when `actor !== origin` (see the revised rule above).
- Entities with no provenance are left alone rather than back-filled — inventing an origin never
  observed is a worse record than none.
- Cascade deletes need no work: provenance lives on the entity and goes with it.
- 17 tests in `packages/core/test/provenance.test.ts`. Full suite green (251 core / 264 web),
  lint and build clean.

Note for PR-3: `exactOptionalPropertyTypes` is on, so any helper taking a provenance-bearing
entity must declare `provenance?: Provenance | undefined` explicitly.

### PR-2 — core: rationale attachment — **DONE**

- `add_table`, `add_relationship`, `set_pk`, `set_type`, `set_cardinality` take an optional
  `rationale: { text, evidence? }`, declared first in each zod literal.
- **Correction to the original bullet:** the zod key order does _not_ drive the emitted field
  order. The response tool types `actions` loosely as `object[]` (`responseTool.ts`), so nothing
  derives a JSON Schema from these zod objects and the model never sees this ordering. The zod
  order documents intent only — **the mechanism that actually puts `rationale` ahead of the
  decision is the example ordering in the system prompt, which is PR-4.** PR-4 is therefore load-
  bearing for the reasoning claim, not just for phrasing.
- `turnId` is _not_ part of the action. It is supplied by the caller via
  `ApplyActionsOptions.turnId` — a model asked for an id it cannot know would invent one.
- `text` is `z.string().min(1)`, so a blank rationale rejects the whole action rather than storing
  an empty explanation.
- Attached only when `actor === "ai"`; on any other actor it is dropped while the action itself
  still applies.
- **Writing a rationale resets `touched` to false**, and runs after `markTouched`. `touched` means
  "drifted from the last authoritative explanation", and a rationale written now _is_ that
  explanation. Without the reset, the copilot re-deciding something the user had edited would
  render its own fresh reasoning as stale.
- An entity with **no** provenance gets one materialized as `origin: "user"` rather than losing the
  rationale. This narrows PR-1's "leave legacy entities alone" rule to the no-rationale case:
  silently dropping the explanation is the exact failure this feature exists to prevent, and
  `user` is the already-documented reading of absent provenance rather than a new inference.
- A later rationale replaces the earlier one; they do not accumulate.
- 11 tests in `packages/core/test/rationale.test.ts`. Suite green (262 core / 264 web).

### PR-3 — store: actor plumbing + history — **DONE**

- `runActions` takes a second argument, `RunActionsOptions { actor?, turnId? }`, so every call site
  declares who is acting. The typed UI commands pass nothing and take the `"user"` default.
- **Correction to the original bullet:** "`runActions` passes `actor: "ai"`" was wrong — it assumed
  `runActions` was the copilot's private entry point. It is shared by **three** callers with three
  different actors:
  - `CopilotPanel.tsx` → `"ai"`, plus a `turnId` minted once per send (the loop can take several
    rounds to satisfy one request, and all its rationales belong to that one turn).
  - `buildFromSource.ts` → **`"imported"`**. This resolves the open question below: the columns are
    the file's own shape read off the parsed source, and distinguishing that from a shape someone
    chose is precisely what origin is for.
  - `useSuggestions.ts` → left at the `"user"` default **deliberately**, and commented in place.
    Suggestions read as an AI feature but are pure local detector findings with no model anywhere
    in the path; stamping them `"ai"` would have the canvas credit the copilot with work it never
    saw, and show a provenance marker with no rationale behind it.
- Undo/redo needed no plumbing — `cloneSnapshot`'s `structuredClone` carries provenance — but it is
  now asserted rather than assumed, in both directions.
- `acceptDraft` preserves provenance through its `SchemaSchema.safeParse` re-check.
- 7 tests in `apps/web/test/provenanceStore.test.ts`; one existing `sources.test.ts` assertion
  updated for the new call shape. Suite green (262 core / 271 web), lint and build clean.

### PR-4 — prompt + response tool — **DONE**

- `ACTION_PROTOCOL` now shows `"rationale"` as the **first** key of the five ops that take one, and
  says so in a header line. This is the mechanism identified in PR-2 — the only place the ordering
  is enforced, since the response tool types `actions` as a loose `object[]`.
- New `<rationale>` section (`RATIONALE_GUIDANCE`) between `<action_protocol>` and `<workflow>`:
  - Required on `add_relationship`, `set_cardinality`, `set_pk`.
  - **Open question 2 resolved:** required on `add_table` when the table is _not_ one source file —
    a junction, a normalization split, an extracted `shared_parent`. Omitted for a plain
    file→table. This is the carve-out the blanket rule would have suppressed, and it covers the
    N:M junction case where grain reasoning matters most.
  - **Open question 3 resolved:** `set_type` carries a rationale only when the type differs from
    the inferred type or resolves a cross-source format conflict. Routine types carry none — that
    was the high-frequency op that would have inflated every turn.
  - Omitted entirely on `add_field`, the renames, and the removals.
  - `text` must cite an observed figure or verdict and must not restate the action; a good example
    (containment % picking the cardinality) and a bad one (restating the link in words) are both
    shown.
  - Closing rule: if you cannot cite a figure for a decision that requires one, you have not
    investigated it — call `probe_join`/`inspect_source` first.
- `responseTool.ts`: the `actions` description points at the rationale rule and the first-key
  requirement.
- Detector block untouched, as required.
- 5 prompt tests in `copilot.test.ts` (including an ordering assertion that reads the actual op
  signature lines) and 2 in `responseTool.test.ts` — one of which pins that a rationale survives
  the model→store path unstripped, since core's zod is the only validator and a dropped rationale
  would fail silently. Suite green (262 core / 277 web).

**Real-file check.** The live eval needs `ANTHROPIC_API_KEY` and was not run. What _was_ run: the
real `local-data/` pair (HRSA CSV + OPAIS JSON, 6 sources after unnesting) pushed through
`parseCsv`/`parseJson` → detectors → both prompt builders. Prompt builds clean; detectors take
3.06s, in line with the documented ~3.7s and unchanged by this PR.

Measured cost of the rationale guidance: **3,842 chars — 25.3% of the static half, 7.5% of the
full prompt.** The static half sits before the provider's prompt-cache breakpoint, so after the
first turn the marginal input cost is ~zero; the first turn pays roughly a thousand tokens. The
**output** cost — rationale text on every qualifying action — remains unmeasured and needs a live
run. Command:

```
ANTHROPIC_API_KEY=sk-... pnpm --filter @grafture/web exec vitest run test/evals.live.test.ts
```

### PR-5 — canvas rendering — **DONE**

- `canvas/provenance.ts`: pure view helpers — `originOf`, `tableOrigin` (the derived rollup,
  including `mixed`), `isTouched`, `isStaleRationale`, `provenanceLabel`.
- Field rows: a 2px left edge via a **`::before`, not an inset shadow or a background**. The row's
  `background` is already the field-selection channel (`App.css`), so an edge painted there would
  vanish exactly when the row is selected — when someone is looking at it.
- Table titles: a dot whose **shape** carries origin as well as hue — filled circle (ai), square
  (imported), half-filled (mixed), hollow (user) — plus `title`/`aria-label` on every marker, to
  hold the a11y floor from `3313245`.
- `user` rows are deliberately **unmarked**. In review mode the question is "what did I not
  write"; marking every hand-authored row is noise that hides the answer.
- Rationale badge (`i`, or `?` + dashed + drained colour when stale) on tables and fields.
  Relationships have no room for a second floating element, so provenance rides the existing
  cardinality chip: `data-origin` tints its border and the glyph sits inside it.
- Review-mode toggle in the canvas toolbar (`reviewMode` on the store — ephemeral, not undoable,
  not persisted), switched on automatically when a copilot turn applies anything.

**Found by running the app — two things the suite could not have caught.**

1. **A rationale on a user-origin entity could never go stale.** PR-2's legacy-materialization path
   lands an AI-written rationale on `origin: "user"`; under the origin-only `touched` rule a later
   user edit matched its own origin, left `touched` false, and the canvas kept presenting a
   now-wrong explanation as current — the exact failure this feature exists to prevent. Reproduced
   live (user changed a type; `touched` stayed false), then fixed in `markTouched`: **once an
   entity carries a rationale, staleness is judged against the explanation's author, and only the
   copilot writes one** — so authorship decides in both directions and origin stops mattering. 4
   regression tests in `rationale.test.ts`.
2. **A touched field with no rationale rendered identically to an untouched one** — a solid bar
   reads as "as the copilot made it", which stops being true after a hand edit, and with no badge
   there was nothing else carrying that meaning. The bar now breaks into a dashed gradient when
   touched.

Verified in the browser against the real project: AI table shows a filled dot + live `i` badge; the
edited AI field shows a dashed edge and `"Created by the AI copilot, edited since"`; the explained
field the user then edited shows the `?` badge and `"Why (edited since): …"`; the AI relationship
label carries the accent border and its rationale in the title; every `user` row is unmarked.

11 tests in `apps/web/test/canvasProvenance.test.ts`. Suite green (266 core / 288 web).

### PR-6 — rationale panel — **DONE**

- Badges became real **buttons**. They were `role="img"` spans relying on `title`, which truncates
  long reasoning and is unreachable by keyboard — unacceptable for the one thing this feature
  exists to show.
- `rationaleFocus` on the store (`{kind, ids}`, ephemeral): cleared when review mode is switched
  off, when another project loads, and when the focus stops resolving.
- `resolveRationale(schema, focus)` reads the entity through the **live schema** rather than
  snapshotting at click time — that is what makes an open panel flip to "edited since" the moment
  the user changes what it describes, instead of continuing to show the state it was opened in.
- `RationalePanel`: subject line, stale banner, reasoning text, cited evidence, origin footer,
  close button, Esc to dismiss. Docked bottom-left rather than anchored to its node — the canvas
  pans and zooms, and a popover tracking a moving node either fights the viewport or drifts
  off-screen. The subject line names what it explains, so proximity is not needed.
- **Correction to the plan:** the edge badge could not stay inside the cardinality chip. That chip
  is itself a button (it cycles cardinality), so a nested button is invalid HTML and unreachable by
  keyboard. The badge is now a sibling positioned just past it.

Verified in the browser on a throwaway project (created, exercised, then deleted — the earlier
PR-5 pass wrote to the real `Test` project, which was restored):

- relationship badge → panel with both evidence tokens and "Created by the AI copilot";
- clicking the cardinality chip by hand → chip goes dashed amber, badge flips `i` → `?`, and the
  **already-open panel** shows the "edited since" banner;
- Esc closes; field badge → `Column · orders.order_id`; table badge → `Table · customers`;
- deleting the focused table clears the focus and removes the panel rather than leaving it stuck.

21 tests in `apps/web/test/canvasProvenance.test.ts`. Suite green (266 core / 298 web).

## What remains

All six PRs are landed. Two things are outstanding, both flagged in the open questions below:

1. **The live run has never happened.** Every layer is verified — provenance, staleness, the
   prompt's contents, the canvas, the panel — but always with rationales I wrote by hand. Nothing
   confirms the model actually emits them first, cites real figures, and does not pad every action.
   That is the acceptance gate for the reasoning claim, not the green suite.
2. **SQL-imported schemas carry no provenance** (`import/sql.ts` bypasses `applyActions`).

## Open questions

1. ~~**Does `imported` earn its place in v1?**~~ **Resolved in PR-3 — yes.** The file→table build
   path (`buildFromSource.ts`) goes through `runActions` and now stamps `"imported"`, so the value
   is live and tested.

   Still outstanding, and narrower than first written: **`packages/core/src/import/sql.ts` builds
   its schema directly rather than through `applyActions`** — it duplicates the FK-badge logic by
   hand (`sql.ts:781`) — so SQL-imported entities carry no provenance and render as `user`. That is
   an acceptable fallback, not a correct one: a schema slurped from an existing database is exactly
   the case where "you did not write this" is worth showing. Needs its own stamping pass; not
   blocking PR-4/5/6.

2. ~~**Rationale on `add_table` for junction tables**~~ **Resolved in PR-4.** Required on
   `add_table` when the table is not one source file (junction, normalization split, extracted
   `shared_parent`); omitted for a plain file→table.
3. ~~**Token cost.**~~ **Partly resolved in PR-4.** Input side measured on the real files: the
   guidance is 3,842 chars, 7.5% of the full prompt, and sits in the cached static half — so the
   recurring input cost is ~zero. `set_type` was scoped to deviating/conflicting types only, which
   was the op that would have inflated output most. **Output cost is still unmeasured** and needs a
   live run.
4. **Does the model actually comply?** Nothing offline can verify that it emits `rationale` first,
   cites real figures, and does not pad every action. This is the open risk PR-4 carries into
   PR-5/6 — a live run should check compliance and rationale quality, not just that actions apply.

## Risks

- **Prompt regression.** PR-4 changes the copilot's output contract; a real-file smoke run against
  `local-data/` is required, not just fixtures — fixture-only validation has previously hidden a
  ranking problem that only real cardinalities exposed.
- **Stale rationale is worse than none.** If the `touched` transition misses a mutation path, the
  canvas asserts a confident wrong reason. PR-1 tests must cover every mutating op, not a sample.
- **Scope creep into `description`.** Explicitly out of scope on this branch.

## Sequencing

PR-1 → PR-2 → PR-3 are core/store and independently testable. PR-4 is the risky one and should
land alone so a prompt regression is bisectable. PR-5/PR-6 are additive UI.
