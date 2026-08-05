# Grafture — Agent Guide

## What this is

Grafture turns a pile of heterogeneous source files (CSV, Excel, JSON) into a
proposed, AI-reasoned relational schema, and exports real migrations from it.

It is **not** "another ERD editor." Every mature tool in this space (ChartDB, DrawDB,
Azimutt) starts from a database or a schema you already have. Grafture starts from
raw data you need to _integrate_ and helps you derive the schema you don't have yet.

The differentiator — protect it in every change — is **content-aware modeling**: the AI
looks at sample values and proposes join keys, flags grain mismatches, and warns about
format conflicts (e.g. two identifier columns that won't match without normalization).
"AI adds a box to the canvas" is table-stakes; reasoning about the data is the product.

## Architecture

pnpm monorepo.

- `packages/core` — framework-agnostic TypeScript engine. The schema domain model, the
  AI action protocol (zod), file parsers, exporters, and the `AiProvider` interface.
  No React. No network/server code. MIT.
- `apps/web` — the open-source React app: sources panel, canvas, copilot, BYO-key AI.
  Depends on `packages/core`. MIT.

The hosted/paid layer (AI proxy + usage metering, accounts, persistence, real-time
collaboration) is **NOT in this repo**. Nothing here may assume a server. The open core
must stay fully usable offline with the user's own API key.

**This package boundary is the licensing line. Do not add hosted/paid functionality to
`packages/core` or `apps/web`.**

## Domain model (the contract)

A `Schema` is `{ tables: Table[], relationships: Relationship[] }`.

- `Table`: `{ id, name, x, y, width?, fields: Field[], provenance? }`
- `Field`: `{ id, name, type, pk: boolean, fk: boolean, provenance? }`
- `Relationship`: `{ id, fromTable, fromField, toTable, toField, cardinality: "1:1" | "1:N" | "N:M", provenance? }`

`Provenance` is `{ origin: "ai" | "user" | "imported", touched: boolean, rationale? }` and
`Rationale` is `{ text, evidence: string[], turnId? }` (`packages/core/src/model.ts`). It is
**optional everywhere** — absent provenance reads as user-owned and is never back-filled, so
schemas saved before it existed still load. Two invariants: provenance covers an entity's **own**
attributes only (a table's is about its name; "is this table AI-generated?" is _derived_ from its
fields, never stored), and `origin`/`touched` are two independent bits rather than one enum so the
mixed cases stay representable.

The AI mutates the canvas only through the **action protocol** — a discriminated union
validated by zod in `packages/core` (the `op` discriminants in
`packages/core/src/actions.ts` are the source of truth; 11 ops as of 2026-08-03):
`add_table | add_field | remove_field | remove_table | rename_table | rename_field | add_relationship | remove_relationship | set_pk | set_type | set_cardinality`.

Five ops accept an optional `rationale` (`add_table`, `add_relationship`, `set_pk`, `set_type`,
`set_cardinality`). **It is declared as the first key on every op that takes one, and that order
is load-bearing** — generation is autoregressive, so a reason emitted before the decision
conditions it, while one emitted after can only defend a choice already made. Nothing in the JSON
Schema enforces the order (the response tool types actions as a loose `object[]`); the system
prompt is the only enforcement, so don't reorder those fields.

Task status and current-state facts live in `HANDOFF.md` — it wins on **facts**; this
file wins on **rules**.

`applyActions(schema, actions, opts?)` in core is a **pure, tested** function. AI output and
manual edits both flow through it. `opts.actor: Origin` (default `"user"`) is what stamps
provenance — core cannot infer who is acting when both paths share one function, so **every
caller declares it**: the copilot passes `"ai"`, building a table from a parsed file passes
`"imported"`, everything else takes the default. A rationale on a non-AI actor is dropped.

## Hard rules

- TypeScript strict. No `any` at module boundaries.
- Every AI-emitted action MUST be validated against the zod action schema before it
  touches state. **Invalid actions are rejected and surfaced to the user, never silently
  dropped.** (The prototype silently no-oped on bad field names — do not reproduce that.)
- All canvas mutations go through the store's typed commands so undo/redo stays correct.
  Never mutate diagram state directly. **Every command also names its history step** — a
  `{ label, actor }` pushed with the snapshot, which is what the history box lists. A step with
  no name is a step the user cannot recognise, so a new command must supply one; label from what
  `applyActions` applied, never from what was requested.
- Core logic (parsers, exporters, `applyActions`) requires vitest tests. Don't land core
  changes without them.
- Keep `packages/core` free of React and of any network/server code.
- Detectors feeding the copilot prompt must stay **pure functions of `sources`**. The prompt's
  detector block is expensive (~3.7s on real files) and is cached on source identity and
  prewarmed on idle in `copilot/systemPrompt.ts` — a detector that reads the schema, the clock,
  or any other state would silently serve stale findings. Never do that work on the send path.
- **Provenance is written once and never rewritten.** `origin` is set at creation; `touched` is
  monotonic (false→true, never cleared except by a freshly written rationale); a rationale is
  frozen at write time and is never user-editable — an explanation the user can rewrite is
  worthless as a record. Never back-fill provenance onto an entity that lacks it.
- **Copilot tools are declared once, in the shared registry** (`copilot/investigationTools.ts`:
  `INVESTIGATION_TOOLS`, `isInvestigationTool`, `runInvestigationTool`, `ToolSpec`). Both provider
  families offer and dispatch through it, so adding a tool is one edit — not a registration plus a
  dispatch arm per provider, which is how a tool got offered but never routed. Read a call's
  arguments with `requiredStringArgs` (`copilot/toolArgs.ts`) so the keys come from the tool's own
  `input_schema.required` and a rename becomes a compile error instead of a silent `""`.
- **Loading states must not lie.** `ui/Pipeline` fills its rail purely from steps that genuinely
  settled — never a timer, never a synthetic percentage. A step still running gets a pulsing dot
  and nothing more. Both ingest surfaces (`sources/ParsingOverlay`, `home/CreateProgress`) share
  it; keep the app to one loading language.

## Stack

- React + TypeScript + Vite (`apps/web`)
- `@xyflow/react` for the canvas; `elkjs` for auto-layout
- Zustand + immer for state, with an undo/redo history
- zod for the domain model + action protocol (in `packages/core`)
- papaparse + SheetJS (xlsx) for parsing (in `packages/core`)
- vitest, eslint, prettier

## Commands

- `pnpm install`
- `pnpm dev` — run the web app
- `pnpm test` — vitest across packages
- `pnpm lint` — eslint + prettier check
- `pnpm build` — typecheck + build

## Working agreement

Work in small, scoped changes. The reference behavior for parsing, the canvas, and the
AI action loop is the original single-file prototype — port its logic into this typed
module structure; don't invent new behavior unless asked. When a task says to leave
something untouched, leave it untouched.
