# Schema Studio — Agent Guide

## What this is

Schema Studio turns a pile of heterogeneous source files (CSV, Excel, JSON) into a
proposed, AI-reasoned relational schema, and exports real migrations from it.

It is **not** "another ERD editor." Every mature tool in this space (ChartDB, DrawDB,
Azimutt) starts from a database or a schema you already have. Schema Studio starts from
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

- `Table`: `{ id, name, x, y, fields: Field[] }`
- `Field`: `{ id, name, type, pk: boolean, fk: boolean }`
- `Relationship`: `{ id, fromTable, fromField, toTable, toField, cardinality: "1:1" | "1:N" | "N:M" }`

The AI mutates the canvas only through the **action protocol** — a discriminated union
validated by zod in `packages/core`:
`add_table | add_field | remove_field | remove_table | rename_table | add_relationship`.

`applyActions(schema, actions)` in core is a **pure, tested** function. AI output and
manual edits both flow through it.

## Hard rules

- TypeScript strict. No `any` at module boundaries.
- Every AI-emitted action MUST be validated against the zod action schema before it
  touches state. **Invalid actions are rejected and surfaced to the user, never silently
  dropped.** (The prototype silently no-oped on bad field names — do not reproduce that.)
- All canvas mutations go through the store's typed commands so undo/redo stays correct.
  Never mutate diagram state directly.
- Core logic (parsers, exporters, `applyActions`) requires vitest tests. Don't land core
  changes without them.
- Keep `packages/core` free of React and of any network/server code.

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
