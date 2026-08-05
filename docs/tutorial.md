# Grafture — guided tutorial

A step-by-step walkthrough that takes you from a cold clone to an exported migration,
touching every feature along the way. It uses the **bundled demo dataset**, so everything
below is reproducible from the repo alone — no private files, no account, no server.

**Time:** ~20 minutes (about 8 without the AI copilot sections).

**What you'll end up with:** two heterogeneous files joined into one relational schema,
with the join proposed from the _values in the data_, and a Postgres migration exported
from it.

> **Optional:** steps 7–10 use the AI copilot and need your own API key. Everything else —
> parsing, the canvas, the content-aware suggestions, export, persistence — works without
> one.

---

## Contents

| #   | Step                                                                             | Needs a key |
| --- | -------------------------------------------------------------------------------- | ----------- |
| 0   | [Set up and run](#0-set-up-and-run)                                              | no          |
| 1   | [Create a project from files](#1-create-a-project-from-files)                    | no          |
| 2   | [Read the Sources panel](#2-read-the-sources-panel)                              | no          |
| 3   | [Build tables from sources](#3-build-tables-from-sources)                        | no          |
| 4   | [Edit on the canvas](#4-edit-on-the-canvas)                                      | no          |
| 5   | [Draw a relationship by hand](#5-draw-a-relationship-by-hand)                    | no          |
| 6   | [The payoff: content-aware suggestions](#6-the-payoff-content-aware-suggestions) | no          |
| 7   | [Connect an AI provider](#7-connect-an-ai-provider)                              | yes         |
| 8   | [Ask the copilot](#8-ask-the-copilot)                                            | yes         |
| 9   | [Review what the AI did, and why](#9-review-what-the-ai-did-and-why)             | yes         |
| 10  | [Walk the history stack](#10-walk-the-history-stack)                             | no          |
| 11  | [Export a migration](#11-export-a-migration)                                     | no          |
| 12  | [Settings worth knowing](#12-settings-worth-knowing)                             | no          |
| 13  | [Projects, persistence, and SQL import](#13-projects-persistence-and-sql-import) | no          |

---

## 0. Set up and run

Grafture needs **Node 22** with Corepack enabled (see `CONTRIBUTING.md` for the full
cold-start notes).

```bash
corepack enable
pnpm install
pnpm dev
```

Open <http://localhost:5173>. You land on the **Projects** home screen.

Locate the demo files now — you'll drag them in twice over the course of this tutorial:

```
apps/web/public/demo/health_centers.csv     # health-center SITES  (many rows per grant)
apps/web/public/demo/covered_entities.json  # the ORGANIZATIONS that hold the grants (one row per grant)
```

They are deliberately shaped like real 340B / HRSA data: joinable on the grant number, but
**only after normalizing it** — the CSV keeps leading zeros (`00489012`), the JSON strips
them (`489012`). That mismatch is what this whole tutorial is built around.

> Everything is parsed **in your browser**. No file ever leaves the machine.

---

## 1. Create a project from files

1. Click **New project** (or the create tile).
2. In the modal, drop both demo files onto the dropzone — or click **Click to browse**.
   Accepted: CSV, XLSX, JSON, up to 50 MB each.
3. Give it a title, e.g. `340B Reconciliation`.
4. Fill in the context box. This is not decoration — it's handed to the copilot as the
   framing for everything it proposes. Try:

   > Reconcile 340B grant data: health-center sites from HRSA and the covered entities that
   > hold the grants. Join on the grant number.

5. Click **Derive schema** (the button reads **Create project** if you have no files, or if
   AI drafting is off in Settings).

**What to watch:** the card morphs into a progress rail with one step per file, then a
_Saving project_ step. The rail only advances when a step genuinely finishes — there is no
fake timer, so a step that sits with a pulsing dot really is still working. Files are parsed
one at a time on purpose (it's synchronous CPU work), with a painted frame between each.

**Try the failure path too:** drop a deliberately malformed `.json` alongside the good files.
The bad file is marked individually — the others still parse and the project still creates.

---

## 2. Read the Sources panel

You're now in the editor: **Sources** on the left, **canvas** in the middle, **Copilot** on
the right. Both side panels collapse to a rail via the chevron in their header.

Expand each source card and look at:

- **Row count and field list.** Row counts are captured uncapped at parse time, even though
  only a sample of rows is retained for detection.
- **Inferred types** per column (`text`, `integer`, `timestamp`, …), inferred from the actual
  values, not from headers.
- **Grouping.** `covered_entities.json` is a flat array here, but if you feed Grafture a JSON
  file with nested arrays-of-objects, each nested array becomes its **own child source**
  listed _underneath_ its parent file, not as an unrelated top-level card. Removing the parent
  cascades to the children as a single undo step.

Add another file at any time with the **+** button in the panel header, or by dropping files
anywhere over the panel.

---

## 3. Build tables from sources

Two ways to get data onto the canvas.

**Whole source → table:** expand a source card and click **Build table**. Grafture creates a
table with every column typed and a primary key guessed from the values. Do this for
`health_centers.csv`.

**One column at a time:** pick a table in the canvas toolbar's **Active table** dropdown,
then click any field chip inside a source card to append just that column. (Without an active
table the chips are disabled and say so on hover.)

Now click **Build table** on `covered_entities.json` too, so both sides are on the canvas.

> Tables built this way are stamped as **imported**, not as your own hand edits or the AI's —
> which matters in step 9.

---

## 4. Edit on the canvas

Everything here goes through the same validated path the AI uses, so all of it is undoable.

| Action                | How                                                        |
| --------------------- | ---------------------------------------------------------- |
| Add an empty table    | **+ Table** in the canvas toolbar                          |
| Rename a table        | Double-click its header                                    |
| Rename a column       | Double-click the column name                               |
| Change a type         | Double-click the type on the right of a column             |
| Toggle a primary key  | Click the key icon on a column                             |
| Remove a column       | The **×** on the column row                                |
| Delete a table        | Select it, press <kbd>Delete</kbd> or <kbd>Backspace</kbd> |
| Resize a table        | Drag its right edge                                        |
| Re-lay out everything | **Auto-arrange** in the top bar (elkjs layout)             |

Bottom-right of the canvas: **zoom in / out**, **fit view**, **fullscreen**, and a **lock**
toggle that freezes panning and node dragging while you read.

Try one now: rename `health_centers` to `sites`. Keep it — step 10 comes back to it.

---

## 5. Draw a relationship by hand

1. Hover a column — connection handles appear on both sides of the row.
2. Drag from `sites.grant_number` to `covered_entities.grant_num`.

The edge appears with a cardinality chip on it. **Click the chip** to cycle
`1:N → N:M → 1:1`. Grafture also sets the `fk` flag on the source column, and clears it again
if you delete the last relationship using that column.

You've just made the join _structurally_. What you have no way of knowing yet is whether it
will actually match at runtime — which is the next step.

---

## 6. The payoff: content-aware suggestions

Switch the right-hand pane to the **Suggestions** tab. This needs **no API key** — it's
deterministic detectors running over your sample values.

For the demo pair you should see the grant-number join surfaced with:

- **A proposed join key**, derived from the _overlap of actual values_ across the two files —
  not from the column names, which don't even match (`grant_number` vs `grant_num`).
- **A format-mismatch warning.** The values overlap semantically but not literally: leading
  zeros on one side, stripped on the other. A raw equality join returns nothing until they're
  normalized. **This is the finding no ERD editor can give you**, because it requires reading
  the data.
- **An inferred grain / cardinality.** Many sites per grant in the CSV, one row per grant in
  the JSON → `1:N`.

Note that a few rows on each side intentionally have no counterpart, so the overlap is
partial and realistic, not a suspiciously perfect join.

**Apply** a card to commit it through the same validated path as everything else;
**Dismiss** hides it without touching the schema. If you have a key connected, the
**Ranked by AI** toggle re-orders cards by relevance — and **Show default** puts the
deterministic order back.

Ten detectors feed this and the copilot's prompt: join keys, format conflicts, grain, primary
keys, semantic types, value sets, composite keys, functional dependencies, relationship
classification, and join probing.

---

## 7. Connect an AI provider

_Everything from here to step 9 needs a key._

Reach the BYO-key page from the copilot's **Connect AI to use Copilot** card, or
**Settings → API keys**.

1. Pick a provider: **Anthropic**, **OpenAI**, or **Local** (any OpenAI-compatible runtime —
   Ollama, LM Studio, llama.cpp, vLLM; no key needed, just a base URL).
2. Paste your key. The eye icon reveals it.
3. Choose whether to remember it on this device. Not remembering keeps it in memory for the
   session only; Settings labels which is which, and shows only the last 4 characters.
4. **Save & continue.** Grafture doesn't just format-check the key — it pings the provider's
   models endpoint. A rejected key (401/403) is blocked. A provider that's merely
   _unreachable_ (offline, CORS, 429) doesn't lock you out: the button becomes
   **Save anyway** and stores the credential unverified.

> **Local models:** if your runtime doesn't support tool calls, Grafture falls back to prompt-
> based JSON mode and tells you so in a chip in the chat. That fallback costs the copilot its
> investigation tools, so the schema it drafts will be less evidence-driven. For Ollama, start
> it with `OLLAMA_ORIGINS` set to the page's origin.

Keys are stored per provider, so you can keep several and switch between them.

---

## 8. Ask the copilot

Back on the canvas, use the **Chat** tab. The model picker beside the input switches models
without going to Settings.

Ask something the copilot can only answer by looking at the data:

> Can I join the health center sites to the covered entities? Show me what would break.

**What to watch for:**

- **The investigation phase.** On a fresh derivation the copilot is deliberately _denied_
  the ability to submit a schema for its first rounds, so it spends them calling tools —
  `probe_join` to test a candidate join against real values, `inspect_source` to look at a
  file more closely, `preview_export` to see what its schema would actually emit. You'll see
  those steps in the chat before any answer.
- **An "Applied · N changes" card** collapsing everything one turn changed. Expand it.
- **"Couldn't apply" lines.** If the model emits an action that fails validation, Grafture
  _tells you_ instead of silently dropping it. That surfacing is a deliberate product
  decision — an AI that quietly no-ops is worse than one that fails loudly.

Then try a follow-up that edits rather than derives:

> Split the address fields out of sites into their own table.

---

## 9. Review what the AI did, and why

Click the **review mode** toggle in the canvas toolbar ("Show where things came from"). It
turns on automatically after a copilot turn.

- **Origin dots** appear on tables, columns, and edges: AI, you, or imported. A table whose
  columns have mixed origins reads as _mixed_ — Grafture doesn't flatten that into a lie.
- A dot also records whether you've since **touched** an AI-made entity.
- **Rationale badges** appear where the copilot gave a reason. Click one to open the
  **reasoning panel**, docked to a corner of the canvas.

The panel shows the model's stated reasoning plus its **evidence** — the measured figures it
cited (containment percentages, distinct counts, an inferred grain, a detector verdict). If
you've edited the entity since, the panel says the rationale is now **stale** rather than
pretending it still describes what's there.

Rationales are frozen at write time and are not editable. An explanation you can rewrite is
worthless as a record.

Review mode is a viewing state — it's not saved with the project and isn't part of undo.

---

## 10. Walk the history stack

Click the **History** button in the canvas toolbar, beside undo/redo.

- Every step is **named for what actually happened** — "Renamed health_centers to sites",
  "Added relationship", not "Change #14".
- Each row carries the same origin dot as the canvas, so you can see who did what.
- A batched copilot turn collapses to "7 changes" — click the **disclosure arrow** to expand
  one line per applied action. That's a separate button from the row itself, so reading a
  batch never accidentally jumps you to it.
- **Click a row to travel there.** Undone steps stay listed above the current one, dimmed, so
  you can go back forward again. There's always an "Initial state" floor.

Shortcuts: <kbd>⌘Z</kbd> / <kbd>⌘⇧Z</kbd> (Ctrl spellings and <kbd>Ctrl+Y</kbd> also work,
on every platform). They work from any panel — but they always yield to a text field you're
typing in, so renaming a table and hitting ⌘Z undoes your typing, not your schema.

Jump back to before the rename in step 4, confirm the canvas reverts, then redo forward.

---

## 11. Export a migration

**Export schema** in the top bar. Three formats, live-previewed:

| Format     | Output                                                                                              |
| ---------- | --------------------------------------------------------------------------------------------------- |
| **DBML**   | dbdiagram-compatible schema definition                                                              |
| **SQL**    | PostgreSQL DDL, incl. `CREATE EXTENSION` lines when types need them (PostGIS, citext)               |
| **Prisma** | `schema.prisma` models, with scalar fallbacks where Postgres types have no direct Prisma equivalent |

**Copy** to the clipboard, or **Download .sql** / `.dbml` / `.prisma`.

Read the SQL and check it against what you built: your primary keys, your foreign keys, the
cardinalities from the edge chips. This is the round-trip the whole tool exists to close.

---

## 12. Settings worth knowing

The gear in the top bar (or on the home screen):

- **API keys** — one credential per provider, add/remove, last-4 display.
- **Model** — which model the copilot uses.
- **Target database** — `postgres` or `prisma`. This grounds the _copilot's_ type
  vocabulary, so it proposes types the target actually has.
- **AI-ranked suggestions** — on/off for step 6's reranking.
- **Initial schema draft** — whether a new project with files auto-drafts a schema. Turning
  it off changes the New Project button from **Derive schema** to **Create project**.
- **Appearance** — light / dark / system. Applies immediately, saved per browser.

---

## 13. Projects, persistence, and SQL import

Click **Grafture** in the top bar to go back to Projects.

- Everything persists locally in your browser — schema, sources, and the copilot conversation.
  No account, no server.
- Cards show last-updated time and a summed row count (shown only when _every_ source has a
  known count, so it never displays a confident undercount).
- **Search** by name; the **Recent / All** toggle switches between updated-desc and
  alphabetical.
- The kebab on a card renames or deletes it, with a confirm dialog.
- **Import .sql** loads an existing schema file straight onto a canvas — everything in it is
  stamped `imported`, so review mode keeps it visually distinct from anything you or the AI
  add afterwards.

To confirm persistence: reload the browser. Your project comes back where you left it.

---

## Where to go next

- **Bring your own messy files.** The demo pair is small and hand-made; the detectors get
  more interesting the more heterogeneous the input.
- **Feed it nested JSON.** Arrays-of-objects unnest into child sources with the parent link
  already inferred, and the copilot will scaffold N:M junction tables where the data calls
  for it.
- **Read `README.md`** for the positioning, and `HANDOFF.md` for the current state of the
  build and what's still open.

## Troubleshooting

| Symptom                                         | Cause / fix                                                                                     |
| ----------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `pnpm install` fails                            | Node 22 + `corepack enable` are required. See `CONTRIBUTING.md`.                                |
| Copilot panel shows "Connect AI to use Copilot" | No key for the selected provider. Step 7.                                                       |
| Local provider won't connect                    | CORS. Start your runtime with the app's origin allowed (`OLLAMA_ORIGINS` for Ollama).           |
| Copilot answers in prose and applies nothing    | A local model without tool-call support. Look for the fallback notice chip in chat.             |
| A file failed to parse                          | The failure is reported per file — the others still loaded. Check for malformed rows/JSON.      |
| Suggestions tab is empty                        | Detectors need at least two sources with overlapping values. Load both demo files.              |
| Reloading lost the widest join detection        | The wide join-value window is in-memory only; a reload degrades to the narrower sampled window. |
