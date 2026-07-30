# Grafture — Design System

> Source-of-truth design tokens and component specs for Grafture, a browser-based
> tool that derives relational schemas from raw data files with AI assistance. This
> document is written to be read as a design-system import: every token has a name and a
> value, every component has explicit states. Treat names as stable identifiers — code
> and design tooling should both resolve `surface.canvas` to the same value.

---

## 1. Principles (read this before the tokens)

Four sentences that should arbitrate any disagreement not resolved by a token below.

1. **Calm over decorative.** The product's job is to make messy, heterogeneous data feel
   tractable. Visual noise — gradients, drop shadows, busy iconography, motion for its
   own sake — works against that job directly.
2. **Data is typographically distinct from chrome.** Anything that came from the user's
   actual source files (column names, sample values, types, exported code) renders in
   monospace. Anything that is the application's own UI (buttons, labels, panel
   headers) renders in the UI sans. This distinction is load-bearing, not aesthetic — it
   teaches the user at a glance what's "their data" vs. "our interface."
3. **The accent color means AI.** One accent color exists in this system and it is used
   almost exclusively for the copilot surface and AI-originated suggestions. It should
   never be spent on generic UI affordances (a primary "Save" button does not need to be
   purple). When the accent appears, it should mean "Claude reasoned about this."
4. **Rejections are not errors.** A suggestion the AI proposed and the system couldn't
   apply is normal, expected, and part of the product's credibility mechanic — it must
   never look or feel like a failure state. Reserve true error red for things that are
   actually wrong (parse failure, invalid file, lost connection).

---

## 2. Color

### 2.1 Neutral scale (graphite/slate — the base of both themes)

A single 14-step neutral ramp. Both light and dark theme are built from this one scale
plus the accent and semantic scales below — not separate palettes. `neutral-0` is
absolute white, `neutral-1300` is near-black; nothing in the UI uses true `#000000` or
`#FFFFFF` directly except where specified.

| Token          | Hex       | Use                                            |
| -------------- | --------- | ---------------------------------------------- |
| `neutral-0`    | `#FFFFFF` | Light theme page background (rare — prefer 25) |
| `neutral-25`   | `#FAFBFC` | Light theme default page background            |
| `neutral-50`   | `#F4F6F8` | Light theme sunken panels (sources list bg)    |
| `neutral-100`  | `#E9ECEF` | Light theme borders, dividers                  |
| `neutral-200`  | `#DCE0E4` | Light theme stronger borders, input borders    |
| `neutral-300`  | `#C2C8CD` | Disabled text on light, icon default (light)   |
| `neutral-400`  | `#9AA1A8` | Muted labels on dark only (2.5:1 on light)     |
| `neutral-450`  | `#8A9199` | Dark theme placeholder / faint text            |
| `neutral-500`  | `#757C84` | Borders, icons, disabled — not body copy       |
| `neutral-550`  | `#6E747B` | Light theme placeholder / faint text           |
| `neutral-600`  | `#5B6168` | Secondary body text (both themes)              |
| `neutral-700`  | `#454A50` | Body text (light theme primary)                |
| `neutral-800`  | `#30343A` | Dark theme sunken panels, light theme headings |
| `neutral-900`  | `#23262B` | Dark theme default page background             |
| `neutral-1000` | `#191B1F` | Dark theme sunken panels (sources list bg)     |
| `neutral-1100` | `#121316` | Dark theme card/surface background             |
| `neutral-1200` | `#0A0B0D` | Dark theme deepest background (canvas void)    |
| `neutral-1300` | `#000000` | Reserved — do not use directly                 |

### 2.2 Accent scale — "Reasoning Violet" (the AI signal)

Deliberately not Anthropic's clay/orange — cooler, quieter, sits well against graphite.
Used for: copilot panel chrome, AI-suggested diffs before acceptance, the accent ring on
AI-proposed canvas elements, the send button in chat.

| Token        | Hex       | Use                                            |
| ------------ | --------- | ---------------------------------------------- |
| `accent-50`  | `#F1EEFC` | AI-suggestion background tint (light)          |
| `accent-100` | `#E1DBFA` | AI-suggestion border (light)                   |
| `accent-300` | `#B6A6F0` | Disabled/quiet accent icon                     |
| `accent-500` | `#7C5CE0` | **Core accent.** Buttons, active copilot state |
| `accent-600` | `#6747C7` | Hover/pressed state of accent-500              |
| `accent-700` | `#52399E` | Text-on-accent-50, dark-theme accent text      |
| `accent-900` | `#241A4A` | AI-suggestion background tint (dark)           |

### 2.3 Semantic scales

Each has exactly the steps the UI needs — no more. Resist adding a `success-50-alt`.

**Success (validation passed, applied, saved)**
| Token | Hex | Use |
|---|---|---|
| `success-50` | `#E9F6EE` | Toast/banner background (light) |
| `success-500`| `#2E9B5C` | Icon, text, border |
| `success-900`| `#0F2C1C` | Toast/banner background (dark) |

**Error (something is actually wrong — parse failure, invalid action, lost save)**
| Token | Hex | Use |
|---|---|---|
| `error-50` | `#FBEAEA` | Toast/banner background (light) |
| `error-500`| `#C8443C` | Icon, text, border |
| `error-900`| `#341212` | Toast/banner background (dark) |

**Caution (rejected-but-expected — the "couldn't apply X because…" surfacing)**

Intentionally _not_ the same hue as error. This is amber, not red — it should read as
"heads up, here's information" rather than "something broke."

| Token         | Hex       | Use                                     |
| ------------- | --------- | --------------------------------------- |
| `caution-50`  | `#FBF3E3` | Rejected-action chip background (light) |
| `caution-500` | `#B8801F` | Icon, text, border                      |
| `caution-900` | `#332406` | Rejected-action chip background (dark)  |

**Info (neutral system messages — "parsed locally, nothing uploaded")**
| Token | Hex | Use |
|---|---|---|
| `info-50` | `#EAF1FB` | Inline note background (light) |
| `info-500`| `#3E72B8` | Icon, text |
| `info-900`| `#13202F` | Inline note background (dark) |

### 2.4 Semantic surface tokens (what components actually consume)

Components should reference these, never raw hex or raw neutral steps. This is the layer
that flips between light and dark.

| Token              | Light value          | Dark value        |
| ------------------ | -------------------- | ----------------- |
| `surface.page`     | `neutral-25`         | `neutral-900`     |
| `surface.panel`    | `neutral-0`          | `neutral-1100`    |
| `surface.sunken`   | `neutral-50`         | `neutral-1000`    |
| `surface.canvas`   | `neutral-25`         | `neutral-1200`    |
| `surface.overlay`  | `neutral-0`          | `neutral-1100`    |
| `surface.scrim`    | `rgba(23,26,31,0.4)` | `rgba(0,0,0,0.6)` |
| `border.default`   | `neutral-100`        | `neutral-800`     |
| `border.strong`    | `neutral-200`        | `neutral-700`     |
| `text.primary`     | `neutral-700`        | `neutral-50`      |
| `text.secondary`   | `neutral-600`        | `neutral-400`     |
| `text.placeholder` | `neutral-550`        | `neutral-450`     |
| `text.disabled`    | `neutral-300`        | `neutral-600`     |
| `text.onAccent`    | `neutral-0`          | `neutral-0`       |
| `text.onError`     | `neutral-0`          | `neutral-900`     |
| `data.value`       | `neutral-700`        | `neutral-100`     |
| `data.label`       | `neutral-600`        | `neutral-400`     |

> **Contrast floor.** Every token above that carries normal-size copy clears WCAG AA
> 4.5:1 against the lightest surface it sits on. The original mapping put
> `text.secondary` at `neutral-500` (4.1:1 on `surface.page`) and `text.placeholder` at
> `neutral-400` (2.5:1) — both failed, which is why `neutral-450` and `neutral-550` were
> added to the ramp. Do not move these roles back up the ramp without re-measuring.
> `text.onError` exists because dark theme's `error-500` is light enough that white
> text on it measures 3.2:1; ink reads 4.7:1.

---

## 3. Typography

### 3.1 Families

- **UI Sans — Inter.** All interface chrome: nav, buttons, panel labels, body copy,
  dialogs. Variable weight, use 400/500/600 only — never 700+ in the UI (headings get
  size and color, not boldness, to stay quiet).
- **Data Mono — JetBrains Mono.** Field names, type badges (`int`, `text`, `date`),
  sample values, exported DBML/SQL/Prisma, the copilot's rendering of action diffs. If
  it came from the user's file or is code the product generates, it's mono.
- **Do not introduce a third family.** No serif anywhere — this is the one clear
  divergence from Anthropic's warmer editorial feel, and it should stay clean: two
  families, fixed roles, no exceptions for "marketing pages."

### 3.2 Type scale

A small, deliberate scale — 8 sizes, 1.25 ratio-ish but hand-tuned for screen rendering.

| Token             | Size / Line height | Weight  | Use                                        |
| ----------------- | ------------------ | ------- | ------------------------------------------ |
| `type.display`    | 32px / 40px        | 600     | Marketing/landing hero only — never in-app |
| `type.heading.lg` | 22px / 28px        | 600     | Panel/page titles ("Sources", "Export")    |
| `type.heading.md` | 17px / 24px        | 600     | Section headers within a panel             |
| `type.body.lg`    | 15px / 22px        | 400     | Default body, chat messages                |
| `type.body.md`    | 13px / 20px        | 400     | Default UI text, table fields, labels      |
| `type.body.sm`    | 12px / 16px        | 400     | Helper text, timestamps, captions          |
| `type.body.xs`    | 11px / 16px        | 400/500 | Badges, chips, type tags, counts only      |
| `type.mono.md`    | 13px / 20px        | 400/500 | Field names, sample values, type badges    |
| `type.mono.sm`    | 12px / 18px        | 400     | Inline code in chat, compact diffs         |

Tracking: UI sans uses default tracking. Mono uses `-0.01em` at sizes above 13px to
offset monospace's naturally loose rhythm.

> `type.body.xs` is a 9th step added after the fact: 25 badge / chip / type-tag /
> count declarations were already shipping at 10–11px, below the stated floor.
> Naming the tier beats a silent off-scale size. It is for **labels only** — never
> running copy, never anything the user has to read a sentence of.

---

## 4. Spacing, radius, elevation

Kept deliberately small so engineers can't "almost" match a value — there should be one
obviously-correct token for any given gap.

**Spacing scale** (4px base unit): `space.1`=4, `space.2`=8, `space.3`=12, `space.4`=16,
`space.5`=24, `space.6`=32, `space.7`=48, `space.8`=64.

**Radius:** `radius.sm`=4px (chips, badges) · `radius.md`=8px (buttons, inputs, cards) ·
`radius.lg`=12px (panels, modals) · `radius.full`=9999px (avatars, pills only).

**Elevation** — used sparingly; most of the UI sits flat on its surface token with a
border, not a shadow. Shadows exist only for things that float above the canvas.

| Token                | Value (light)                     | Value (dark)                  |
| -------------------- | --------------------------------- | ----------------------------- |
| `shadow.sm`          | `0 1px 2px rgba(23,26,31,0.06)`   | `0 1px 2px rgba(0,0,0,0.4)`   |
| `shadow.md`          | `0 4px 12px rgba(23,26,31,0.10)`  | `0 4px 16px rgba(0,0,0,0.5)`  |
| `shadow.lg` (modals) | `0 12px 32px rgba(23,26,31,0.16)` | `0 12px 32px rgba(0,0,0,0.6)` |

No glows, no colored shadows — even on accent-colored elements.

---

## 5. Components

### 5.1 Buttons

- **Primary** — `surface.panel` text in `text.onAccent`, background `accent-500`,
  hover `accent-600`. Radius `radius.md`. Reserve for the single most important action
  in a given context (e.g. "Apply" on a suggestion, "Export").
- **Secondary** — transparent background, `border.default`, `text.primary`. This is the
  default button — most actions in the app should be secondary, not primary, to keep
  the accent meaningful.
- **Destructive** — transparent background until hover, `error-500` text and border;
  fills `error-50`/`error-900` on hover. Used for delete table, remove source.
- All buttons: `type.body.md`, weight 500, padding `space.2` vertical / `space.4`
  horizontal, no all-caps, no letter-spacing tricks.

### 5.2 Toasts / inline banners

Four variants, each pinned to its semantic scale at the `-50`/`-500`/`-900` triplet.
Structure is identical across variants — only color and icon change, deliberately, so
the user reads color/icon, not layout, to tell them apart.

- **Success** — check icon, `success` scale. Auto-dismiss 4s.
- **Error** — alert-triangle icon, `error` scale. Persists until dismissed.
- **Caution** (rejected AI action) — info-circle icon (not a warning triangle — this is
  not alarming), `caution` scale. Lives inline in the chat transcript, not as a toast —
  it's conversational, not an interruption.
- **Info** — dot icon, `info` scale. Used for the "parsed locally" trust copy and
  similar ambient notices.

### 5.3 Modals / popups

- Background `surface.overlay`, scrim `surface.scrim` behind it, radius `radius.lg`,
  `shadow.lg`.
- Max width 480px for confirmation dialogs, 640px for content dialogs (export preview).
- Title uses `type.heading.md`, body `type.body.lg`.
- Always two actions max in the footer: one secondary (cancel/dismiss), one
  primary-or-destructive depending on the action. Never three competing buttons.
- Destructive confirmations (delete project, delete table) use the destructive button
  style and require the action name to literally appear in the body copy ("Delete
  `organizations`? This can't be undone.") — no generic "Are you sure?"

### 5.4 Suggestion cards (joins, keys, types — the GF-9 detector output)

This is the component family most specific to this product, so it gets its own
treatment rather than reusing a generic "card."

- Background `accent-50` (light) / `accent-900` (dark) — the _only_ place this tint is
  used outside the copilot panel itself, reinforcing "AI noticed this."
  Border `accent-100`/`accent-700`.
- Header row: `type.body.md` weight 500, plain language ("Possible join:
  `covered_entities.grant_number` ↔ `organizations.grant_number`").
  - Adjacent fields/values inline use `type.mono.sm` to keep schema identifiers visually
    distinct from the surrounding sentence.
- Evidence line below header in `text.secondary` + `type.body.sm`: overlap %, grain,
  any format-mismatch note. This is what makes it "content-aware" rather than "AI vibes"
  — the evidence should always be visible, never hidden behind a tooltip.
- Two actions, right-aligned, both small/secondary-weight: "Apply" (primary-style only
  on hover, otherwise quiet) and "Dismiss." Applying always animates the resulting
  canvas change briefly (200ms highlight pulse in `accent-300`, not a full glow).

### 5.5 Canvas (tables, fields, relationships)

- Table node: `surface.panel` background, `border.default`, `radius.md`, `shadow.sm`.
  Header row uses `type.heading.md`; field rows use `type.mono.md` for the field name
  and type badge, `type.body.sm` for inline sample-value preview in `data.label` color.
- PK indicator: small filled dot in `neutral-700`/`neutral-100`, not a star/key glyph —
  quieter, and reads at a glance without needing a legend.
- FK badge: text "FK" in `type.mono.sm`, `text.secondary`.
- Relationship edges: 1.5px stroke `border.strong`, cardinality label on a small pill
  (`surface.panel` bg, `border.default`, `radius.full`) using `type.mono.sm`.
- AI-just-applied table/field: 200ms highlight transition through `accent-300` back to
  default border — confirms the action landed without leaving a permanent color scar.

### 5.6 Copilot panel

- The one part of the UI allowed to feel slightly "different" — background uses
  `surface.sunken` rather than `surface.panel`, to read as a distinct lane, not a modal.
- User messages: right-aligned, `surface.panel` bubble, `text.primary`.
- Assistant messages: left-aligned, no bubble — just `text.primary` directly on the
  panel background, prefixed by a small static accent-colored mark (not an animated
  avatar). Plain-text reasoning stays in `type.body.lg`; any schema identifiers
  referenced inline switch to `type.mono.sm`.
- Applied/rejected action chips render inline at the bottom of the relevant assistant
  message — applied in a quiet neutral chip, rejected in the `caution` treatment from
  §5.2. Never collapse rejections into a "1 action failed" summary; each one stays
  individually legible, since the per-action reasoning is the credibility mechanic.

---

## 6. Iconography & motion

- **Icons:** Lucide (already a dependency family via `lucide-react`), 1.5px stroke,
  20px default size, never filled except the small PK dot in §5.5. No custom icon set —
  consistency matters more than uniqueness here.
- **Motion:** 150–200ms ease-out for hovers and highights, 200ms ease-in-out for
  panel/modal open. Nothing bounces, nothing overshoots. Canvas auto-arrange (elkjs) may
  animate node repositioning over 300ms — the one place slightly longer motion is
  earned, because it's communicating a real spatial change.

---

## 7. Voice (brief — full content style is a separate doc if needed)

- Plain, declarative, no exclamation points. "Couldn't apply — `grant_number` doesn't
  exist on `organizations`." not "Oops! Something went wrong!"
  - Never invent false urgency or use marketing language inside the product itself.
- The product narrates its own reasoning in suggestion evidence lines (§5.4) rather than
  asking the user to trust a black box — voice should always show the "why," briefly.

---

## 8. What this system is not

- Not warm/editorial (no cream, no serif, no hand-drawn accents) — that's the
  Anthropic-proper look and this should sit visibly apart from it while staying in the
  same quiet-minimalist family.
  - It also intentionally avoids the all-caps-mono dense indigo "terminal" aesthetic of
    Linear/Raycast — this is calmer and more spaced-out than those.
- Not playful — no mascots, no illustrations of database tables as cute objects.
- Not dense-as-default — generous whitespace even on data-heavy screens; density is
  something the user opts into (e.g. a future "compact mode"), not the resting state.
