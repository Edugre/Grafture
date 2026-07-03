# Contributing to Schema Studio

Thanks for helping build Schema Studio. This guide covers setup, the commands you'll run,
and the one architectural rule that keeps the project coherent.

## Setup

You need **Node 22** and **pnpm** (pinned via the `packageManager` field). The simplest way
to get the right pnpm is Corepack:

```bash
corepack enable
pnpm install
```

## Commands

| Command       | What it does                               |
| ------------- | ------------------------------------------ |
| `pnpm dev`    | Run the web app at <http://localhost:5173> |
| `pnpm test`   | Run the vitest suite across packages       |
| `pnpm lint`   | ESLint + Prettier check                    |
| `pnpm build`  | Typecheck + build core and the web app     |
| `pnpm format` | Auto-format with Prettier                  |

**A change isn't done until `pnpm test`, `pnpm lint`, and `pnpm build` are all green.**

## Project layout

pnpm monorepo:

- **`packages/core`** — the engine: schema domain model, the zod action protocol, file
  parsers, exporters, and the content-aware detectors. Pure TypeScript.
- **`apps/web`** — the React app: sources panel, canvas, copilot, and the reviewable
  suggestions UI. Depends on `packages/core`.

## The rules that matter

These keep the project's core promise intact — read them before a first PR.

1. **`packages/core` stays React-free and network-free.** The app as a whole stays
   server-free and offline-first: it must remain fully usable with only the user's own API
   key, and files are parsed in the browser and never uploaded.
2. **Every schema mutation goes through core's `applyActions`** — the single validated path.
   Never mutate diagram state directly; canvas edits go through the store's typed commands so
   undo/redo stays correct.
3. **Invalid or inapplicable actions are rejected and surfaced to the user, never silently
   dropped.** Surfacing _why_ something couldn't apply is part of the product.
4. **TypeScript strict; no `any` at module boundaries.**
5. **Core logic (parsers, exporters, `applyActions`, detectors) ships with vitest tests.**
   Don't land core changes without them.

## Working agreement

- Work in **small, scoped changes.** Say what you're leaving untouched, not just what you
  changed.
- Match the surrounding code's style, naming, and idioms.
- The behavior reference for parsing, the canvas, and the AI action loop is the existing
  implementation — port and extend it; don't invent new behavior unless the issue asks for it.

## Pull request checklist

- [ ] Change is scoped to one concern.
- [ ] Core logic has vitest coverage.
- [ ] `pnpm test`, `pnpm lint`, and `pnpm build` are green.
- [ ] No React or network code added to `packages/core`.
- [ ] If the change affects task status, action ops, detectors, or file layout:
      `HANDOFF.md` updated in the same PR (or N/A).
