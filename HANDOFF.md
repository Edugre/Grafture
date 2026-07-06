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

- `Table = { id, name, x, y, width?, fields: Field[] }` (`width` is optional presentation
  geometry, resized via the store's `resizeTable` command)
- `Field = { id, name, type, pk: boolean, fk: boolean }`
- `Relationship = { id, fromTable, fromField, toTable, toField, cardinality: "1:1"|"1:N"|"N:M" }`

Action protocol (zod discriminated union in core, discriminated on `op`). **The `op`
discriminants in `packages/core/src/actions.ts` are the source of truth**; snapshot as of
2026-07-03 on `feat/copilot-intelligence` — 11 ops:
`add_table | add_field | remove_field | remove_table | rename_table | rename_field |
add_relationship | remove_relationship | set_pk | set_type | set_cardinality`.

> **Branch caveat:** on `main`, `actions.ts` has **10 ops (no `rename_field`)**, and T7's
> second tranche (`setFieldType`/`renameField` routing) is not landed — its first tranche
> (`togglePk`/`removeRelationship`/`setCardinality`) is on `main`. The rest lives on the
> unmerged `feat/copilot-intelligence`. If you base
> work on `main`, expect that delta; land/merge that branch before anything that depends
> on §3 as written. (CLAUDE.md's older 7-op list has been corrected; where CLAUDE.md and
> this file disagree on **facts**, this file wins — CLAUDE.md wins on **rules**.)

T7 is done (on the branch): every store command routes through `applyActions`
(`rename_field` was added so manual field renames could too). `add_relationship` now sets
the from-field's `fk` flag and removals clear it when the last relationship on that field
goes away.

### Commands

`pnpm install` · `pnpm dev` · `pnpm test` · `pnpm lint` · `pnpm build`

Cold-start notes: **Node 22 + Corepack** required (setup details in CONTRIBUTING.md).
The API key is entered on the BYO-key page (`apps/web/src/byokey/ByoKeyPage.tsx`),
reached from a copilot CTA or Settings → API keys. The bundled demo dataset
(`apps/web/public/demo/`) is **not auto-loaded** — drag its files into the Sources panel.

---

## 4. Current status

**Open-Core v1 feature loop is SHIPPED** (SS-0 → SS-9). Clone → `pnpm dev` → upload files →
build a schema with AI that reasons over sample values → export a migration → persists
locally, with no account and no server. 299 tests green as of 2026-07-03
(the count rots — verify with `pnpm test`).

| Epic                          | State                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Core engine (SS-0/1/2)        | ✅ model, action protocol, parsers (incl. even-spread row sampling, null-token handling, `timestamp` type)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| Web foundation (SS-3/4/5)     | ✅ store, canvas, sources panel                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| Ingestion + AI (SS-6)         | ✅ copilot + agentic loop + BYO key; `preview_export` agentic tool (on `main`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Round-trip (SS-7/8)           | ✅ exporters (DBML/SQL/Prisma) + local persistence                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Modeling intelligence (SS-9)  | ✅ detectors, copilot-fed — the list rots; source of truth is the exports of `packages/core/src/detect/index.ts` (7 as of 2026-07-03: join, format, grain, PK, semantic-type, value-set, composite-key)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| Copilot intelligence overhaul | ✅ on `feat/copilot-intelligence` (**unmerged as of 2026-07-03** — verify with `git branch --merged main`): target profiles, forced tool call, `inspect_source` agentic tool, retained row tuples, `rename_field` op, T7's second tranche, undo-history cap + autosave delete guard + AI fetch timeouts                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| Multi-provider AI (T18)       | ✅ on `feat/copilot-intelligence`: OpenAI Chat-Completions provider (`apps/web/src/ai/OpenAiBrowserProvider.ts`), provider registry (`ai/providers.ts`), per-provider key storage (`secretStore`/`useApiKey`) + per-provider model preference, unified Settings model dropdown, Cursor-style chat model picker (`copilot/ModelPicker.tsx` driven by `useAllModels`), **and the Local provider**: a shared `OpenAiCompatibleProvider` base (`ai/openaiCompatible.ts`) with a keyless `LocalBrowserProvider` (`ai/LocalBrowserProvider.ts`) for any OpenAI-compatible runtime (Ollama/LM Studio/llama.cpp/vLLM). Credential presentation/validation is generalized onto `ProviderMeta.credential`. **Deferred: prompt-based JSON fallback for local models without function-calling** (non-tool models currently surface as `blocked`). |
| Suggestions UI                | ✅ merged: `apps/web/src/suggest/` — full inventory and consumers below this table                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| **Launch packaging (SS-10)**  | 🟨 **T5 (static deploy) + T6 (demo clip) are the remaining gap** — T1–T4 landed (PR #12; verify by artifact: `ls .github/workflows/ci.yml CONTRIBUTING.md apps/web/public/demo/`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| Design follow-ups             | 🟨 see §6 for the live deferred/done/blocked states                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |

**Suggestions subsystem map** (for anyone extending _or removing_ it):
`apps/web/src/suggest/` holds `SuggestionsTab`, `SuggestionsToast`, `joinSuggestions.ts`,
`useSuggestions.ts`, `useRankedSuggestions.ts`, `rerank.ts`, `rerankPreference.ts`, their
CSS files, and an `index.ts` barrel. **Not all imports go through the barrel** — two
files deep-import: `settings/SettingsPage.tsx` (`useRerankPreference`) and, notably,
`ai/AnthropicBrowserProvider.ts` (`parseRankingResponse` from `rerank.ts` — the provider
layer depends on this UI-feature dir; an architectural wrinkle to keep in mind).
Consumers outside the dir: `App.tsx` (imports the toast and lifts `copilotTab` /
`activeSuggestionId` state for its "View suggestions" CTA), `CopilotPanel.tsx`,
`CanvasPanel.tsx` + `canvas/suggestionPreview.ts` (suggestion preview; the latter
type-imports from the barrel), `schemaStore.ts` (`dismissedSuggestionIds` state, no
import), `SettingsPage.tsx`, and `AnthropicBrowserProvider.ts`.
T11 depends on `joinSuggestions.ts`.

**Other load-bearing modules the board doesn't otherwise name:**

- `packages/core/src/target/` — the copilot's **export-grounding contract** (grounds
  exports via the _prompt_ — `TARGET_PROFILES` does not feed exporter code; the SQL
  extension map and Prisma fallbacks are hardcoded in `export/index.ts` and merely
  _described_ by the profiles, so behavior changes must be mirrored in both places):
  `TargetIdSchema` (`postgres | prisma`), `TARGET_PROFILES` (per-target type vocabularies,
  extension rules like PostGIS/citext auto-`CREATE EXTENSION`, Prisma scalar fallbacks),
  `DEFAULT_TARGET`, `describeTargetForPrompt` (consumed by `copilot/systemPrompt.ts`).
  Own test file. UI side: `apps/web/src/ai/{targetPreference,modelPreference,models,useModels}.ts`
  drive the target-database and model selectors in `SettingsPage.tsx`. **T10's
  export-inclusion decision (D1) runs through this module.**
- **Eval harness**: `apps/web/test/evals.offline.test.ts` (deterministic golden-fixture
  prompt regressions, always runs) + `evals.live.test.ts` (opt-in live-model eval,
  `describe.runIf` on `ANTHROPIC_API_KEY` — this is the "1 skipped" in the test count
  when no key is set; run command in its header). T8's manual QA overlaps the live eval's
  draft-quality half — run the eval first, QA what it can't cover (UI surfacing).
- Web export surface: `apps/web/src/export/ExportMenu.tsx` (the UI over core's exporters).
- Shell/utility dirs not on the board (small, self-explanatory): `topbar/`, `ui/`,
  `theme/`, plus canvas auto-layout (`canvas/{arrangeBridge,layout}.ts`, elkjs).

---

## 5. Task board — prioritized

Priority key: **P0** launch blocker · **P1** core to public launch · **P2** valuable, ships
after launch · **P3** polish / nice-to-have.

### P0 — Launch packaging (SS-10) · owner: _unassigned_

The only thing standing between v1 and a public "Show HN" launch. Ships in `apps/web` root /
repo root, isolated from the store/canvas spine — safe to own end-to-end.

| #   | Task                                                                                        | Notes                                                                                                                                                                                                                                                                                                                                                                                    |
| --- | ------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| T1  | ✅ **Done.** README leads with the file-first positioning (_not_ "another ERD editor")      | Landed via PR #12 (`feat/launch-packaging`).                                                                                                                                                                                                                                                                                                                                             |
| T2  | ✅ **Done.** CONTRIBUTING.md: dev setup, `pnpm` commands, package-boundary rule             | Landed via PR #12.                                                                                                                                                                                                                                                                                                                                                                       |
| T3  | ✅ **Done.** CI — `.github/workflows/ci.yml` runs lint + test + build on PRs + push-to-main | Landed via PR #12.                                                                                                                                                                                                                                                                                                                                                                       |
| T4  | ✅ **Done.** Bundled demo dataset (HRSA/340B style) in `apps/web/public/demo/`              | `health_centers.csv` + `covered_entities.json`, deliberate grain difference.                                                                                                                                                                                                                                                                                                             |
| T5  | **Static demo deploy**                                                                      | No deploy workflow/config exists yet; `apps/web/vite.config.ts` has no `base` setting (needed for GH Pages subpath hosting). BYO-key **does** survive static hosting — `AnthropicBrowserProvider` sends `anthropic-dangerous-direct-browser-access` for CORS, so "no server" is real. Host choice + whether the deployed demo auto-loads the bundled dataset: see Decisions D2/D3 (§8a). |
| T6  | Short demo clip                                                                             | The Show-HN moment.                                                                                                                                                                                                                                                                                                                                                                      |

LICENSE (MIT) already exists.

### P1 — Correctness debt on the validated path · owner: _unassigned_

These undermine rule #2 (everything through `applyActions`). Small, core-adjacent, worth
doing before launch so the contract holds.

| #   | Task                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | Where                                                                                      |
| --- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| T7  | ✅ **Done.** Every store command routes through `applyActions`: `togglePk`/`removeRelationship`/`setCardinality` (with the `set_cardinality` op) landed first; `setFieldType` (via `set_type`) and `renameField` (via a new core `rename_field` op) followed. No `commitSnapshot` schema mutations remain outside pure-visual geometry — **except the wholesale schema swaps listed under T20**.                                                                                                                                                                                                                                              | `apps/web/src/store/schemaStore.ts` + `packages/core/src/actions.ts`                       |
| T8  | **Manual QA pass** with a real Anthropic key, reproducible from the repo alone: first run the scripted live eval (`apps/web/test/evals.live.test.ts` — command in its header) which covers draft quality; then in the browser, upload the bundled demo pair (`apps/web/public/demo/health_centers.csv` + `covered_entities.json`), prompt the copilot to derive a joined schema across them (the grain-difference join is the point), and verify rejected-action surfacing in chat — the part the eval can't cover. (The older "OPAIS upload" referred to gitignored `local-data/` files a second collaborator won't have.)                   | browser + `pnpm test`                                                                      |
| T20 | ✅ **Done.** Both wholesale-swap gaps are now guarded: `acceptDraft` re-validates the draft with `SchemaSchema.safeParse` before the swap (invalid drafts are discarded and surfaced as an error chat message — the draft is _built_ via `applyActions` in `CopilotPanel.tsx`, so the parse is a contract guard, not a replay); and `loadProject`'s activate path validates schema + sources via `validateProjectRecord` (`serialize.ts`) before the store swap — a corrupted IndexedDB record is rejected with a surfaced error, never loaded. Undo/redo restore remains the one sanctioned unvalidated swap (inherent to snapshot history). | `apps/web/src/store/schemaStore.ts`, `apps/web/src/persistence/{serialize,useProjects}.ts` |

### P2 — High-value design follow-ups (unlock multiple features)

Grouped by root cause: knocking out the model change unblocks several UI items at once.

| #   | Task                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | Unblocks                                                  | Where                                                                                                                                                               |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| T9  | ✅ **Done.** Model side: `rowCount` on `SourceSchema` (`parse/types.ts`), captured uncapped at parse; `sampleRows`/`distinctValues`/`stats` also exist. UI side: per-source row counts in the sources-panel card meta, and a summed `rowCount` on `ProjectSummary` shown in the Home card footer (hidden when 0/unknown for legacy sources).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | DESIGN #7 (source row counts), #15 (project footer rows). | UI: sources panel + `apps/web/src/persistence/projectStore.ts`                                                                                                      |
| T10 | **Proposed/applied relationship state on canvas.** Read this before starting — the naive "add `status` to `Relationship`" spec was wrong in two ways. (1) **Three proposal-visual mechanisms already exist**: the whole-schema draft/`acceptDraft` preview (`schemaStore.ts`), the per-suggestion purple overlay (`canvas/suggestionPreview.ts` + `PreviewOverlay.tsx`), and the `--proposed` ghost styles in `App.css`. Decide unify-vs-coexist first (Decisions D1, §8a) or you'll build a fourth. (2) **"Rejected" cannot live on `Relationship`**: a rejected `add_relationship` never creates a Relationship row (rule #3 surfaces it in chat), so the enum on the model is `proposed \| applied` only; "Couldn't apply" is a chat/suggestion-surface concern. Touch list beyond the obvious: `packages/core/src/actions.ts` (default status in `add_relationship`; who flips proposed→applied?), `canvas/CanvasPanel.tsx` (where edges are constructed), `persistence/serialize.ts` (`status` must be **optional** or every saved project fails zod on load), and the export path — `packages/core/src/export/` plus its UI surface `apps/web/src/export/ExportMenu.tsx` and the target-grounding in `packages/core/src/target/` (proposed relationships in DBML/SQL/Prisma exports: include or exclude? — Decisions D1). | DESIGN #6 — the visible payoff of content-aware joins.    | `packages/core/src/model.ts` + `actions.ts` first (one PR), then `apps/web/src/canvas/{RelationshipEdge,TableNode,CanvasPanel}.tsx` + `serialize.ts` (follow-up PR) |
| T11 | **Content-aware status badges on Home cards** (inferred/mismatch/validated). Needs per-project detector run at list time — mind perf on large files.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | DESIGN #13.                                               | `listProjectSummaries` in `apps/web/src/persistence/projectStore.ts`, reuse `suggest/joinSuggestions.ts`, `+status` on `ProjectSummary`                             |
| T12 | ✅ **Done.** Live credential validation on save: `validateCredentialLive` (`ai/validateCredential.ts`) pings the provider's models endpoint (all three providers, via `listModels`) and distinguishes a rejected key (401/403) from an unreachable server — local failures are phrased as server/CORS problems, not bad credentials. `ByoKeyPage` gates Save behind format check → live check with a `validating` state (disabled inputs, "Checking…" button, helper-line status) and the existing inline-error surface. Last-4 display already existed (`maskKey` in `SettingsPage`); non-remembered keys show from the in-memory context with the "In memory · this session only" caption.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |

### P3 — Polish / later

| #   | Task                                                                                                                                                                                                                                                                                                                                                                                                                     | Where (DESIGN #) |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------- |
| T13 | General settings page (workspace name, detector toggles, min-overlap threshold) — wire toggles to detectors.                                                                                                                                                                                                                                                                                                             | #8               |
| T14 | Multi-key / multi-provider management (set active, retry, kebab). Depends on OpenAI/Local providers.                                                                                                                                                                                                                                                                                                                     | #3, #10          |
| T15 | "Usage this month" stats — needs local request logging around the provider.                                                                                                                                                                                                                                                                                                                                              | #11              |
| T16 | Per-project type icons + project `type` field.                                                                                                                                                                                                                                                                                                                                                                           | #14              |
| T17 | Home "Derive from files" as a direct drop target.                                                                                                                                                                                                                                                                                                                                                                        | #17              |
| T18 | ✅ **OpenAI + Local `AiProvider`s shipped** on `feat/copilot-intelligence`. OpenAI Chat-Completions provider + provider registry + per-provider key/model storage + unified Settings model dropdown + Cursor-style chat model picker; then the Local provider via a shared `OpenAiCompatibleProvider` base + keyless `LocalBrowserProvider`. Deferred: prompt-based JSON fallback for local models without tool-calling. | #3               |
| T19 | User avatar / account identity — blocked on there being no account model in the OSS app.                                                                                                                                                                                                                                                                                                                                 | #16              |

---

## 6. Deferred design-follow-up index

> DESIGN #s are historical IDs from a retired local doc (`DESIGN_FOLLOWUPS.md`, no longer
> extant). The **Item** column is the spec; the numbers are just stable cross-reference keys.

| DESIGN # | Item                                          | Task            | Status                                                             |
| -------- | --------------------------------------------- | --------------- | ------------------------------------------------------------------ |
| 1        | Real provider key validation                  | T12             | ✅ done                                                            |
| 2        | `keyStatus: validating` state                 | T12             | ✅ done                                                            |
| 3        | OpenAI + Local providers                      | T18/T14         | ✅ both shipped (Local JSON-fallback for non-tool models deferred) |
| 4        | Settings page + key revocation                | —               | ✅ done                                                            |
| 5        | Last-4 display after save                     | T12             | ✅ done (maskKey in Settings; in-memory keys covered)              |
| 6        | Proposed/applied relationship state on canvas | T10             | deferred                                                           |
| 7        | Source-file row counts                        | T9              | ✅ done                                                            |
| 8        | General settings page                         | T13             | deferred                                                           |
| 9        | Data & privacy / Members / Billing nav        | —               | not built (no account/backend in the OSS app)                      |
| 10       | Multi-key management                          | T14             | deferred                                                           |
| 11       | "Usage this month" stats                      | T15             | deferred                                                           |
| 12       | Theme Save/Cancel + colors                    | —               | ✅ done (immediate-apply, purple accent — intentional deviation)   |
| 13       | Content-aware Home status badges              | T11             | deferred                                                           |
| 14       | Per-project type icons                        | T16             | deferred                                                           |
| 15       | Project row counts in card footer             | T9 (root cause) | ✅ done                                                            |
| 16       | User avatar / account identity                | T19             | blocked on account model                                           |
| 17       | "Derive from files" drop target               | T17             | deferred                                                           |

---

## 7. Working agreement for two people

- **Don't both edit the store/canvas spine in the same window.** Suggested split:
  - **Owner A → launch track:** T5/T6 (the open remainder of SS-10) + T8 QA. Repo-root /
    packaging, isolated. (T1–T4 landed via PR #12.)
  - **Owner B → model track:** T10 (the `Relationship.status` model change) plus the UI
    wiring T9 left open (DESIGN #7/#15). (T7, T9, and T20 are done.)
- **Land core-model changes first** (T10) before the UI that depends on them — one PR
  for the model + zod + `applyActions` + tests, a follow-up PR for the UI.
- Every PR: `pnpm test && pnpm build && pnpm lint` green; name what you left untouched.
- **Branch base:** merge `feat/copilot-intelligence` before starting model-track work — §3's
  contract describes that branch, not `main`. Owner A's packaging work (T5/T6) is
  repo-root-isolated and safe to base on `main` meanwhile.
- If your PR changes task status, ops, detectors, or file layout, **update this file in the
  same PR** (also stated in CONTRIBUTING.md's checklist — that's the enforcement hook).

---

## 8. Locked decisions (don't re-litigate mid-build)

- **`packages/core` + `apps/web` are MIT and server-free.** The app stays fully usable
  offline with the user's own API key.
- **Positioning = file-first schema derivation from raw data**, not "another AI ERD tool."
- **The differentiator = content-aware modeling reasoning + code round-trip**, not the canvas.
- **AI capability stays in the app via BYO key.**

---

## 8a. Open decisions (forward-action options only)

| ID  | Question                                                                                                                                                                               | Options (first = recommended)                                                                                                                                                                                                                                                                                |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| D1  | T10: three proposal-visual mechanisms exist (draft/`acceptDraft`, suggestion `PreviewOverlay`, `--proposed` CSS). Unify or coexist? And do `proposed` relationships appear in exports? | **(a)** One status-driven mechanism: `Relationship.status` becomes the single source, `PreviewOverlay` renders from it, draft preview retired into it; proposed rows **excluded** from exports. (b) Keep draft preview for New Project only, status for per-relationship — two mechanisms, documented split. |
| D2  | T5: deploy host?                                                                                                                                                                       | **(a)** GitHub Pages via a `deploy.yml` workflow + Vite `base` setting — zero new accounts, same platform as CI. (b) Netlify/Cloudflare Pages — nicer URLs, no `base` needed.                                                                                                                                |
| D3  | T5: does the deployed demo auto-load the bundled dataset?                                                                                                                              | **(a)** Auto-load behind a "Try the demo data" CTA on Home — the Show-HN visitor sees content-aware joins in one click. (b) Keep manual drag, add a visible hint.                                                                                                                                            |

---

## 9. Adversarial review log

**Last full re-verify: 2026-07-03.** Treat every count/status above as stale if `HEAD`
has moved materially since.

- **R1 (fact-check, 2026-07-03):** Doc was ~10 commits stale. Folded: T1–T4 marked done
  (PR #12), T9 model side done (`rowCount` shipped), branch + test count corrected,
  `feat/copilot-intelligence` + suggestions-UI work added to §4, `Table.width` added to
  the contract, detector list extended, T10 marked partially built, §7 split re-scoped.
- **R2 (hostile-contributor + decay audit, 2026-07-03):** Folded: branch-relative caveat
  in §3 (`main` has 10 ops, no `rename_field`); T10 rewritten (three existing preview
  mechanisms, "rejected" can't live on `Relationship`, serialize/export touch points);
  T20 added (`acceptDraft` bypasses `applyActions`); T5/T8/T12 specs made executable;
  suggestions-subsystem map added; cold-start notes added; free-floating counts converted
  to pointers/commands; §8a Decisions table added; CLAUDE.md op list corrected + fact/rule
  tie-break stated; CONTRIBUTING.md gained the update-HANDOFF checklist line.
  Rejected: a claimed precedence conflict with a local-only (gitignored) working note —
  that note's own header already concedes precedence to this file (reviewer misparse).
- **R3 (fresh-eyes post-fold, 2026-07-03):** All heavy R2 claims verified against source.
  Folded: T7 now cross-references T20's sanctioned-swap exceptions; T20 lists undo/redo +
  `loadProject` as sanctioned wholesale swaps; suggestions map gained the `index.ts`
  barrel + CSS files; detector pointer names `detect/index.ts` exports.
  **Action item (not foldable): HANDOFF.md, CLAUDE.md, and CONTRIBUTING.md edits are
  working-tree-only — commit and push all three together or none of this exists for the
  second collaborator.**
- **R4 (completeness-by-omission + fold-validation, 2026-07-03):** Refuted R3's barrel
  claim (SettingsPage + AnthropicBrowserProvider deep-import `suggest/`; both added to
  the consumer map, provider→suggest dependency flagged). Folded: `packages/core/src/target/`
  - the model/target preference layer documented (load-bearing for T10/D1); eval harness
    documented and wired into T8; `inspect_source` + branch hardening added to §4;
    `loadProject`'s unvalidated activate path corrected and pulled into T20's scope;
    `ExportMenu.tsx` added to T10's touch list; branch caveat made precise (T7 tranche 1 is
    on `main`).
- **R5 (fold-validation, 2026-07-03): CLEAN.** All R4-introduced claims confirmed against
  source; no new SEV-1/SEV-2. Two nits folded: `suggestionPreview.ts` added to the
  consumer map; noted that `TARGET_PROFILES` grounds exports via prompt text only (the
  exporter code hardcodes the same rules — keep them mirrored). **Review exited here:
  all six inventory angles ran (fact-check, hostile-contributor, decay, fresh-eyes,
  completeness-by-omission, inverse-use/doc-drift via R2), and the final validation was
  clean.**
