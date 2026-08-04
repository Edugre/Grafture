/**
 * The first-run tour, as data. Copy is verbatim from `docs/tutorial.md` by way of the onboarding
 * design handoff — no JSX here, so a copy edit never touches the overlay.
 *
 * `target` names a `data-tour` attribute somewhere in the editor shell; the overlay finds it with
 * `querySelector`. Adding a step to a new element is one attribute plus one entry below.
 *
 * `stage` is what the step needs *open* before its anchor exists at all. The editor opens with both
 * side rails collapsed and every source card closed, so a tour that only measured would spend four
 * of its ten steps pointing at nothing. The overlay applies a step's stage on entry and hands the
 * pre-tour arrangement back when it closes — the tour borrows the layout, it doesn't keep it.
 */

/** Every `data-tour` key the tour looks for. The union is what keeps a typo from compiling. */
export type TourAnchor =
  | "source-card"
  | "build-table"
  | "canvas-toolbar"
  | "relationship"
  | "suggestions"
  | "chat"
  | "provenance"
  | "export";

/** What a step needs arranged before it can point at anything. Absent keys mean "don't care". */
export type TourStage = {
  /** Sources rail expanded. */
  sources?: boolean;
  /** The first source card expanded, so its field list and Build table row are on screen. */
  sourceCard?: boolean;
  /** Copilot rail expanded. */
  copilot?: boolean;
  /** Which Copilot tab to show. Only honoured when the tab actually exists. */
  copilotTab?: "chat" | "suggestions";
};

export type TourStep = {
  /** `null` renders a centered card over a plain full-surface scrim (steps 1 and 10). */
  target: TourAnchor | null;
  eyebrow: string;
  title: string;
  body: string;
  note?: string;
  /** Overrides the default "Next" on the first and last steps. */
  nextLabel?: string;
  stage?: TourStage;
};

export const TOUR_STEPS: readonly TourStep[] = [
  {
    target: null,
    eyebrow: "Welcome",
    title: "Two files in, one relational schema out.",
    body: "This project already holds the HRSA health-center sites and the covered entities that hold their grants. The tour walks the ten things worth knowing, in the order you'd actually use them.",
    note: "health_centers.csv · covered_entities.json",
    nextLabel: "Start",
  },
  {
    target: "source-card",
    eyebrow: "Step 2 · Sources",
    title: "Types come from the values, not the headers.",
    body: "Each card carries an uncapped row count and a type per column, inferred from the data itself. Nested arrays inside a JSON file become their own child sources, listed under their parent.",
    note: "Parsed in-browser · nothing is uploaded",
    stage: { sources: true },
  },
  {
    target: "build-table",
    eyebrow: "Step 3 · Build",
    title: "A whole source, or one column at a time.",
    body: "Build table types every column and guesses a primary key from the values. Or set an active table and click individual field chips to append just those columns.",
    note: "Tables made this way are stamped imported",
    stage: { sources: true, sourceCard: true },
  },
  {
    target: "canvas-toolbar",
    eyebrow: "Step 4 · Canvas",
    title: "Every edit goes through the path the copilot uses.",
    body: "Double-click a table name, a column, or a type to change it. Delete removes a selection, dragging the right edge resizes. Because it is all one validated path, all of it is undoable.",
    note: "⌘Z / ⌘⇧Z — yields to the field you're typing in",
  },
  {
    target: "relationship",
    eyebrow: "Step 5 · Relationships",
    title: "Drag between two columns to join them.",
    body: "Handles appear on a column when you hover it. Click the cardinality chip on the finished edge to cycle 1:N, N:M, 1:1 — the foreign-key flag is set and cleared for you.",
  },
  {
    target: "suggestions",
    eyebrow: "Step 6 · Suggestions",
    title: "The finding no ERD editor can give you.",
    body: "Ten detectors read your sample values, no API key involved. Here they matched the grant number across two columns whose names disagree — and caught that one side pads with leading zeros, so a raw equality join would return nothing.",
    note: "Apply commits it · Dismiss leaves the schema alone",
    stage: { copilot: true, copilotTab: "suggestions" },
  },
  {
    target: "chat",
    eyebrow: "Step 7 · Copilot",
    title: "Ask something only the data can answer.",
    body: "On a fresh derivation the copilot is denied the ability to submit a schema for its first rounds, so it spends them investigating — probing the join, inspecting a file, previewing the export. Actions that fail validation are shown to you, never silently dropped.",
    note: "Needs your own key: Anthropic, OpenAI, or a local runtime",
    stage: { copilot: true, copilotTab: "chat" },
  },
  {
    target: "provenance",
    eyebrow: "Step 8 · Provenance",
    title: "Who made this, and on what evidence.",
    body: "Origin dots mark every table, column, and edge as yours, the AI's, or imported. Rationale badges open the reasoning panel with the measured figures the model cited — and say so plainly when your later edits made that reasoning stale.",
    note: 'History names each step: "Renamed health_centers to sites"',
  },
  {
    target: "export",
    eyebrow: "Step 9 · Export",
    title: "DBML, Postgres DDL, or Prisma.",
    body: "All three are live-previewed from the schema in front of you, with your primary keys, foreign keys, and cardinalities carried through. Copy it, or download the file.",
    note: "Import .sql works the same way in reverse",
  },
  {
    target: null,
    eyebrow: "Done",
    title: "That's the loop.",
    body: "Files in, evidence surfaced, schema agreed, migration out — and everything stays in this browser. Bring your own messy files next; the detectors get more interesting the more heterogeneous the input.",
    nextLabel: "Start building",
  },
];

export const TOUR_STEP_COUNT = TOUR_STEPS.length;
