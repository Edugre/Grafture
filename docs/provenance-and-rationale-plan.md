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

### PR-3 — store: actor plumbing + history

- `runActions` passes `actor: "ai"`; the typed UI commands pass `actor: "user"`.
- Verify undo/redo restores provenance — should be free via `structuredClone` in `cloneSnapshot`,
  but assert it in a test rather than assuming.
- `acceptDraft` must preserve provenance from the draft schema.

### PR-4 — prompt + response tool

- `responseTool.ts`: document the rationale field in the `actions` description.
- `systemPrompt.ts`: require a rationale on relationship/cardinality/PK/type actions, and require
  it to cite a detector finding or probe result — not restate the action. Give one good and one
  bad example. Explicitly: no rationale on obvious `add_table` from a single source file.
- Keep the detector block untouched — it is cached and prewarmed, and must stay a pure function of
  `sources`.

### PR-5 — canvas rendering

- Provenance marker: 2px left edge on the field row (`.table-node__field`), header dot on the
  table for mixed/AI tables. **Not** background color — `--surface-hover` is already the
  field-selection background (`App.css:505`), node selection uses the accent border/ring
  (`App.css:484`), and `CopilotPanel.tsx:203` selects affected tables post-turn. Background and
  border are spoken for by transient state.
- Non-color redundant channel (marker shape + `title`/aria text) to hold the a11y floor landed in
  `3313245`.
- Rationale badge on relationships and fields that have one; stale rationale renders muted with an
  explicit "edited since" label.
- Gate the provenance markers behind a **review-mode toggle**, default on immediately after a
  copilot turn. Provenance matters intensely for ~a minute and near-zero a week later; permanent
  chrome for it would outweigh genuinely urgent canvas state.

### PR-6 — rationale panel

Click a badge → panel showing rationale text, cited evidence, the turn it came from, and whether
it is stale. Reuses the existing suggestion-card `rationale` presentation where possible
(`systemPrompt.ts:488`).

## Open questions

1. **Does `imported` earn its place in v1?** Resolved to "not free": `packages/core/src/import/sql.ts`
   builds the schema directly rather than going through `applyActions` — it duplicates the FK-badge
   logic by hand (`sql.ts:781`). So `imported` needs its own stamping pass in the SQL importer.
   Recommend keeping the enum value in the model (so no migration later) but deferring the importer
   stamping to a follow-up; imported entities read as `user` until then, which is the correct
   fallback since the user does own them.
2. **Rationale on `add_table` for junction tables** — the N:M junction case (`systemPrompt.ts:275`)
   is exactly where a rationale is most valuable, but the blanket "no rationale on add_table" rule
   would suppress it. Likely needs a carve-out for tables created as junctions.
3. **Token cost.** Requiring rationale on every relationship inflates output on every turn. Worth
   measuring against a real run before deciding whether to also require it on `set_type`.

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
