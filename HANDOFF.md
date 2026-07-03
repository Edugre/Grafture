# Schema Studio — Collaboration Handoff

> Single source of truth for two people working the codebase together. Self-contained:
> the task board (§5), the deferred design-follow-up index (§6), and the locked decisions
> (§8) live here directly. Where any local working note disagrees, **this file wins** —
> update it as work lands.

---

## 1. What this is (30-second version)

Schema Studio turns heterogeneous source files (CSV / Excel / JSON) into a proposed,
AI-reasoned relational schema and exports real migrations. It is **not** another ERD
editor: every competitor (ChartDB, DrawDB, Azimutt) starts from a database you already
have. We start from **raw data you need to integrate**.

**The differentiator — protect it in every change:** _content-aware modeling_. The AI and
the deterministic detectors look at sample values to propose join keys, flag grain
mismatches, and warn about format conflicts (e.g. two ID columns that won't match without
normalization). "AI adds a box to the canvas" is table-stakes; **reasoning about the data
is the product.**

---

## 2. Architecture

pnpm monorepo:

- **`packages/core`** — framework-agnostic TS engine: domain model, zod action protocol,
  parsers, exporters, detectors, the `AiProvider` interface. **No React. No network/server
  code.** MIT.
- **`apps/web`** — the OSS React app: sources panel, canvas, copilot, BYO-key AI, settings,
  home. Depends on `packages/core`. MIT.

The app must stay **fully usable offline with the user's own API key**. Nothing here may
assume a server.

> **Keep `packages/core` React-free and network-free, and keep the whole app server-free.**

---

## 3. Non-negotiable rules (the done-bar on every task)

1. TypeScript strict. **No `any` at module boundaries.**
2. Every schema mutation goes through core's **`applyActions`** — the single validated path.
   Never mutate diagram state directly. All canvas edits go through the store's typed
   commands so **undo/redo stays correct**.
3. Every AI-emitted action is **validated against the zod action schema** before it touches
   state. Invalid/inapplicable actions are **rejected and surfaced to the user, never
   silently dropped.** (This surfacing _is_ the product's credibility.)
4. `packages/core` stays **React-free and network-free.**
5. Core logic (parsers, exporters, `applyActions`, detectors) ships with **vitest tests.**
6. A task is not done until **`pnpm test`, `pnpm build`, and `pnpm lint` are green.**
7. Work in **small, scoped changes.** Each task names what to **leave untouched.** Don't
   invent behavior unless the task asks for it — the prototype is the behavior reference.

### Domain model (the contract)

`Schema = { tables: Table[], relationships: Relationship[] }`

- `Table = { id, name, x, y, fields: Field[] }`
- `Field = { id, name, type, pk: boolean, fk: boolean }`
- `Relationship = { id, fromTable, fromField, toTable, toField, cardinality: "1:1"|"1:N"|"N:M" }`

Action protocol (zod discriminated union in core, discriminated on `op`) —
**11 ops confirmed in `packages/core/src/actions.ts`:**
`add_table | add_field | remove_field | remove_table | rename_table | rename_field |
add_relationship | remove_relationship | set_pk | set_type | set_cardinality`.
T7 is done: every store command routes through `applyActions` (`rename_field` was added so
manual field renames could too). `add_relationship` now sets the from-field's `fk` flag and
removals clear it when the last relationship on that field goes away.

### Commands

`pnpm install` · `pnpm dev` · `pnpm test` · `pnpm lint` · `pnpm build`

---

## 4. Current status

**Open-Core v1 feature loop is SHIPPED** (SS-0 → SS-9). Clone → `pnpm dev` → upload files →
build a schema with AI that reasons over sample values → export a migration → persists
locally, with no account and no server. ~167 tests green (verify with `pnpm test`).

| Epic                         | State                                               |
| ---------------------------- | --------------------------------------------------- |
| Core engine (SS-0/1/2)       | ✅ model, action protocol, parsers                  |
| Web foundation (SS-3/4/5)    | ✅ store, canvas, sources panel                     |
| Ingestion + AI (SS-6)        | ✅ copilot + agentic loop + BYO key                 |
| Round-trip (SS-7/8)          | ✅ exporters (DBML/SQL/Prisma) + local persistence  |
| Modeling intelligence (SS-9) | ✅ join/format/grain/PK/type detectors, copilot-fed |
| **Launch packaging (SS-10)** | 🟨 **the remaining gap for public launch**          |
| Design follow-ups            | 🟨 17 deferred items (mostly UI wiring, see §6)     |

Current branch: `feat/suggestions-tab-toast`.

---

## 5. Task board — prioritized

Priority key: **P0** launch blocker · **P1** core to public launch · **P2** valuable, ships
after launch · **P3** polish / nice-to-have.

### P0 — Launch packaging (SS-10) · owner: _unassigned_

The only thing standing between v1 and a public "Show HN" launch. Ships in `apps/web` root /
repo root, isolated from the store/canvas spine — safe to own end-to-end.

| #   | Task                                                                                      | Notes                                                         |
| --- | ----------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| T1  | **README** leading with the positioning sentence (file-first, _not_ "another ERD editor") | Keep it product-focused; don't paste internal strategy notes. |
| T2  | **CONTRIBUTING.md**                                                                       | Dev setup, `pnpm` commands, package-boundary rule.            |
| T3  | **CI** — `.github/workflows` running lint + test + build on PR                            | Gate the done-bar automatically.                              |
| T4  | **Bundled demo dataset** (HRSA + OPAIS style)                                             | The data that shows off content-aware joins.                  |
| T5  | **Static demo deploy**                                                                    | Static build of the OSS app; no server dependency.            |
| T6  | Short demo clip                                                                           | The Show-HN moment.                                           |

LICENSE (MIT) already exists.

### P1 — Correctness debt on the validated path · owner: _unassigned_

These undermine rule #2 (everything through `applyActions`). Small, core-adjacent, worth
doing before launch so the contract holds.

| #   | Task                                                                                                                                                                                                                                                                                                                                    | Where                                                                |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| T7  | ✅ **Done.** Every store command routes through `applyActions`: `togglePk`/`removeRelationship`/`setCardinality` (with the `set_cardinality` op) landed first; `setFieldType` (via `set_type`) and `renameField` (via a new core `rename_field` op) followed. No `commitSnapshot` schema mutations remain outside pure-visual geometry. | `apps/web/src/store/schemaStore.ts` + `packages/core/src/actions.ts` |
| T8  | **Manual QA pass** with a real Anthropic key: canonical grant-number prompt end-to-end; HRSA CSV + OPAIS upload; verify rejected-action surfacing in chat.                                                                                                                                                                              | browser                                                              |

### P2 — High-value design follow-ups (unlock multiple features)

Grouped by root cause: knocking out the model change unblocks several UI items at once.

| #   | Task                                                                                                                                                                                                                                    | Unblocks                                                  | Where                                                                                                                                   |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| T9  | **Add `rowCount` to `SourceSchema`**, capture during parse.                                                                                                                                                                             | DESIGN #7 (source row counts), #15 (project footer rows). | `packages/core/src/parse/types.ts` + `parse/` + tests                                                                                   |
| T10 | **Proposed/applied/rejected relationship state on canvas**: add `status` to `Relationship` (+ zod + `applyActions` + tests), then dashed-purple edge, purple ring + join-key row, purple cardinality pill, amber "Couldn't apply" chip. | DESIGN #6 — the visible payoff of content-aware joins.    | `packages/core/src/model.ts` first, then `apps/web/src/canvas/{RelationshipEdge,TableNode}.tsx`, `App.css` (tokens exist)               |
| T11 | **Content-aware status badges on Home cards** (inferred/mismatch/validated). Needs per-project detector run at list time — mind perf on large files.                                                                                    | DESIGN #13.                                               | `listProjectSummaries` in `apps/web/src/persistence/projectStore.ts`, reuse `suggest/joinSuggestions.ts`, `+status` on `ProjectSummary` |
| T12 | **Real BYO-key validation**: add `validate()`/ping to `AnthropicBrowserProvider`; wire `keyStatus: empty\|validating\|valid\|invalid` + inline error; last-4 display after save.                                                        | DESIGN #1, #2, #5.                                        | `apps/web/src/byokey/ByoKeyPage.tsx`, `apps/web/src/ai/`, `useApiKey`/`ApiKeyContext`/`secretStore`                                     |

### P3 — Polish / later

| #   | Task                                                                                                         | Where (DESIGN #) |
| --- | ------------------------------------------------------------------------------------------------------------ | ---------------- |
| T13 | General settings page (workspace name, detector toggles, min-overlap threshold) — wire toggles to detectors. | #8               |
| T14 | Multi-key / multi-provider management (set active, retry, kebab). Depends on OpenAI/Local providers.         | #3, #10          |
| T15 | "Usage this month" stats — needs local request logging around the provider.                                  | #11              |
| T16 | Per-project type icons + project `type` field.                                                               | #14              |
| T17 | Home "Derive from files" as a direct drop target.                                                            | #17              |
| T18 | OpenAI + Local `AiProvider` implementations.                                                                 | #3               |
| T19 | User avatar / account identity — blocked on there being no account model in the OSS app.                     | #16              |

---

## 6. Deferred design-follow-up index

| DESIGN # | Item                                          | Task            | Status                                                           |
| -------- | --------------------------------------------- | --------------- | ---------------------------------------------------------------- |
| 1        | Real provider key validation                  | T12             | deferred                                                         |
| 2        | `keyStatus: validating` state                 | T12             | deferred                                                         |
| 3        | OpenAI + Local providers                      | T18/T14         | deferred                                                         |
| 4        | Settings page + key revocation                | —               | ✅ done                                                          |
| 5        | Last-4 display after save                     | T12             | deferred                                                         |
| 6        | Proposed/applied relationship state on canvas | T10             | deferred                                                         |
| 7        | Source-file row counts                        | T9              | deferred                                                         |
| 8        | General settings page                         | T13             | deferred                                                         |
| 9        | Data & privacy / Members / Billing nav        | —               | not built (no account/backend in the OSS app)                    |
| 10       | Multi-key management                          | T14             | deferred                                                         |
| 11       | "Usage this month" stats                      | T15             | deferred                                                         |
| 12       | Theme Save/Cancel + colors                    | —               | ✅ done (immediate-apply, purple accent — intentional deviation) |
| 13       | Content-aware Home status badges              | T11             | deferred                                                         |
| 14       | Per-project type icons                        | T16             | deferred                                                         |
| 15       | Project row counts in card footer             | T9 (root cause) | deferred                                                         |
| 16       | User avatar / account identity                | T19             | blocked on account model                                         |
| 17       | "Derive from files" drop target               | T17             | deferred                                                         |

---

## 7. Working agreement for two people

- **Don't both edit the store/canvas spine in the same window.** Suggested split:
  - **Owner A → launch track:** T1–T6 (SS-10) + T8 QA. Repo-root / packaging, isolated.
  - **Owner B → correctness + model track:** T7, then T9/T10 (the `Relationship` and
    `Source` model changes that unblock the design follow-ups).
- **Land core-model changes first** (T9, T10) before the UI that depends on them — one PR
  for the model + zod + `applyActions` + tests, a follow-up PR for the UI.
- Every PR: `pnpm test && pnpm build && pnpm lint` green; name what you left untouched.

---

## 8. Locked decisions (don't re-litigate mid-build)

- **`packages/core` + `apps/web` are MIT and server-free.** The app stays fully usable
  offline with the user's own API key.
- **Positioning = file-first schema derivation from raw data**, not "another AI ERD tool."
- **The differentiator = content-aware modeling reasoning + code round-trip**, not the canvas.
- **AI capability stays in the app via BYO key.**
