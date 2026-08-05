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
 *
 * `requires` is the other half of that. Half this tour describes things that only exist once files
 * are loaded, and an empty project is a first-class state here — the New Project modal offers it
 * outright. So the sequence is *resolved* against the project before the tour opens
 * ({@link resolveSteps}): a step whose requirement isn't met runs its variant if it has one and
 * drops out if it doesn't. Nothing is entered and then abandoned, and the counter counts the steps
 * the user is actually going to see.
 */

/** Every `data-tour` key the tour looks for. The union is what keeps a typo from compiling. */
export type TourAnchor =
  | "source-card"
  | "sources-empty"
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

/**
 * What a step's authored copy assumes the project already has. A step whose requirement isn't met
 * either runs its {@link TourVariant} or drops out of the sequence entirely — it is never entered
 * and abandoned, because a card the user watches disappear is worse than one they never saw.
 */
export type TourRequirement = "sources" | "relationships" | "suggestions";

/**
 * What a copy variant is selected on. Distinct from {@link TourRequirement}, which decides whether a
 * step runs at all — a condition only decides which words it runs with.
 */
export type TourCondition =
  /** The bundled demo pair is loaded, so copy written about it is literally true. */
  | "demo-dataset"
  /** No files yet. */
  | "no-sources";

/**
 * Copy for a step under a particular condition. Only the fields it names are overridden; the rest
 * fall through to the step's base copy. Ordered per step, first match wins.
 */
export type TourVariant = {
  when: TourCondition;
  target?: TourAnchor | null;
  title?: string;
  body?: string;
  /** `null` drops the base note — used where the note names something this case doesn't have. */
  note?: string | null;
};

export type TourStep = {
  /** `null` renders a centered card over a plain full-surface scrim (the first and last steps). */
  target: TourAnchor | null;
  /**
   * The label alone — "Sources", not "Step 2 · Sources". The numeral is derived from the step's
   * place in the *resolved* sequence, so it can never disagree with the counter beneath it.
   */
  label: string;
  /** False for the bookend steps, which read "Welcome" and "Done" rather than "Step 1 · …". */
  numbered: boolean;
  /**
   * The base copy is what's true of **any** project. Where the handoff wrote about the bundled demo
   * dataset by name, that text lives in a `demo-dataset` variant instead — see the note at the top
   * of this file.
   */
  title: string;
  body: string;
  note?: string;
  /** Overrides the default "Next" on the first and last steps. */
  nextLabel?: string;
  stage?: TourStage;
  requires?: TourRequirement;
  variants?: TourVariant[];
};

export const TOUR_STEPS: readonly TourStep[] = [
  {
    target: null,
    label: "Welcome",
    numbered: false,
    title: "Messy files in, one relational schema out.",
    body: "Grafture reads the values inside your CSV, Excel, and JSON files and works out the schema that joins them. The tour walks the things worth knowing, in the order you'd actually use them.",
    nextLabel: "Start",
    variants: [
      {
        // The handoff's copy, verbatim — and only where it is true. It names the two demo files and
        // says what they hold, which is the first sentence of the product; on someone else's data it
        // would open by describing files they have never seen.
        when: "demo-dataset",
        title: "Two files in, one relational schema out.",
        body: "This project already holds the HRSA health-center sites and the covered entities that hold their grants. The tour walks the ten things worth knowing, in the order you'd actually use them.",
        note: "health_centers.csv · covered_entities.json",
      },
      {
        when: "no-sources",
        body: "Grafture reads the values inside your CSV, Excel, and JSON files and works out the schema that joins them. This project is empty so far — the tour walks what's here, in the order you'd actually use it.",
      },
    ],
  },
  {
    target: "source-card",
    label: "Sources",
    numbered: true,
    title: "Types come from the values, not the headers.",
    body: "Each card carries an uncapped row count and a type per column, inferred from the data itself. Nested arrays inside a JSON file become their own child sources, listed under their parent.",
    note: "Parsed in-browser · nothing is uploaded",
    stage: { sources: true },
    // With no files there are no cards to describe, but the dropzone that makes them is right
    // there — so the step keeps its point and moves the ring onto the control that earns it.
    requires: "sources",
    variants: [
      {
        when: "no-sources",
        target: "sources-empty",
        body: "Drop a CSV, Excel, or JSON file here and every column gets a type inferred from the data itself rather than its header, alongside an uncapped row count. Nested arrays inside a JSON file become their own child sources, listed under their parent.",
      },
    ],
  },
  {
    target: "build-table",
    label: "Build",
    numbered: true,
    title: "A whole source, or one column at a time.",
    body: "Build table types every column and guesses a primary key from the values. Or set an active table and click individual field chips to append just those columns.",
    note: "Tables made this way are stamped imported",
    stage: { sources: true, sourceCard: true },
    // No variant: "Build table" is a button on a source card, and with no sources there is no card
    // and no honest thing to ring. Step 2's variant already carries the "drop a file" beat.
    requires: "sources",
  },
  {
    target: "canvas-toolbar",
    label: "Canvas",
    numbered: true,
    title: "Every edit goes through the path the copilot uses.",
    body: "Double-click a table name, a column, or a type to change it. Delete removes a selection, dragging the right edge resizes. Because it is all one validated path, all of it is undoable.",
    note: "⌘Z / ⌘⇧Z — yields to the field you're typing in",
  },
  {
    target: "relationship",
    label: "Relationships",
    numbered: true,
    title: "Drag between two columns to join them.",
    body: "Handles appear on a column when you hover it. Click the cardinality chip on the finished edge to cycle 1:N, N:M, 1:1 — the foreign-key flag is set and cleared for you.",
    // No variant: the whole step is about an edge that exists. Describing one that doesn't is the
    // "centered modal narrating an invisible feature" this design set out to avoid.
    requires: "relationships",
  },
  {
    target: "suggestions",
    label: "Suggestions",
    numbered: true,
    title: "The finding no ERD editor can give you.",
    body: "Ten detectors read your sample values, no API key involved. They propose join keys from the values that actually overlap, flag identifiers that won't compare without normalizing first, and work out the grain on each side — with the measured figures on the card.",
    note: "Apply commits it · Dismiss leaves the schema alone",
    stage: { copilot: true, copilotTab: "suggestions" },
    // No `no-sources` variant: the step is about findings, and there are none before there are
    // values. `requires` drops it instead.
    requires: "suggestions",
    variants: [
      {
        // "Here they matched…" points at a card on screen. That sentence is only true of the demo
        // pair; against anyone else's files it narrates a finding the panel isn't showing.
        when: "demo-dataset",
        body: "Ten detectors read your sample values, no API key involved. Here they matched the grant number across two columns whose names disagree — and caught that one side pads with leading zeros, so a raw equality join would return nothing.",
      },
    ],
  },
  {
    target: "chat",
    label: "Copilot",
    numbered: true,
    title: "Ask something only the data can answer.",
    body: "On a fresh derivation the copilot is denied the ability to submit a schema for its first rounds, so it spends them investigating — probing the join, inspecting a file, previewing the export. Actions that fail validation are shown to you, never silently dropped.",
    note: "Needs your own key: Anthropic, OpenAI, or a local runtime",
    stage: { copilot: true, copilotTab: "chat" },
  },
  {
    target: "provenance",
    label: "Provenance",
    numbered: true,
    title: "Who made this, and on what evidence.",
    body: "Origin dots mark every table, column, and edge as yours, the AI's, or imported. Rationale badges open the reasoning panel with the measured figures the model cited — and say so plainly when your later edits made that reasoning stale.",
    // Shows the *shape* of a history entry without quoting a rename of a table the user may not
    // have. The demo project gets the handoff's concrete example, which is a real entry there.
    note: 'History names each step — "Renamed <table>", not "Undo"',
    variants: [
      {
        when: "demo-dataset",
        note: 'History names each step: "Renamed health_centers to sites"',
      },
    ],
  },
  {
    target: "export",
    label: "Export",
    numbered: true,
    title: "DBML, Postgres DDL, or Prisma.",
    body: "All three are live-previewed from the schema in front of you, with your primary keys, foreign keys, and cardinalities carried through. Copy it, or download the file.",
    note: "Import .sql works the same way in reverse",
  },
  {
    target: null,
    label: "Done",
    numbered: false,
    title: "That's the loop.",
    body: "Files in, evidence surfaced, schema agreed, migration out — and everything stays in this browser. Bring your own messy files next; the detectors get more interesting the more heterogeneous the input.",
    nextLabel: "Start building",
  },
];

/**
 * What the project has, as the tour needs to know it. Read from the store once when the tour opens
 * and then frozen: a sequence that restructured because the user dropped a file mid-tour would
 * renumber the card they are currently reading.
 */
export type TourContext = {
  hasSources: boolean;
  hasRelationships: boolean;
  hasSuggestions: boolean;
  /** The bundled demo pair is loaded — see `demoDataset.ts` for what that costs to know. */
  hasDemoDataset: boolean;
};

/** A step with its variant applied and its eyebrow numbered — what the overlay actually renders. */
export type ResolvedStep = {
  target: TourAnchor | null;
  /** Fully formed, e.g. `Step 2 · Sources`. */
  eyebrow: string;
  title: string;
  body: string;
  note?: string;
  nextLabel?: string;
  stage?: TourStage;
};

function isMet(requirement: TourRequirement, context: TourContext): boolean {
  switch (requirement) {
    case "sources":
      return context.hasSources;
    case "relationships":
      return context.hasRelationships;
    case "suggestions":
      return context.hasSuggestions;
  }
}

function holds(condition: TourCondition, context: TourContext): boolean {
  switch (condition) {
    case "demo-dataset":
      return context.hasDemoDataset;
    case "no-sources":
      return !context.hasSources;
  }
}

/** The step's copy under the first variant that applies, falling through to the base. */
function selectCopy(
  step: TourStep,
  context: TourContext,
): { target: TourAnchor | null; title: string; body: string; note: string | undefined } {
  const variant = step.variants?.find((candidate) => holds(candidate.when, context));

  return {
    target: variant?.target !== undefined ? variant.target : step.target,
    title: variant?.title ?? step.title,
    body: variant?.body ?? step.body,
    // `null` is how a variant drops a base note it would otherwise inherit.
    note: variant?.note !== undefined ? (variant.note ?? undefined) : step.note,
  };
}

/**
 * The steps this project can actually show, in order, with their eyebrows numbered against the
 * resolved length. On a project with files this is all ten and every string matches the handoff
 * verbatim; on an empty project it is seven.
 */
export function resolveSteps(
  context: TourContext,
  steps: readonly TourStep[] = TOUR_STEPS,
): ResolvedStep[] {
  // A step survives if it has no requirement, if the requirement is met, or if a variant applies
  // that speaks to the case the requirement is about — otherwise there is no honest version of it
  // here and it drops rather than flashes.
  const runnable = steps.filter(
    (step) =>
      !step.requires ||
      isMet(step.requires, context) ||
      step.variants?.some((variant) => holds(variant.when, context)),
  );

  return runnable.map((step, position) => {
    const copy = selectCopy(step, context);

    return {
      target: copy.target,
      eyebrow: step.numbered ? `Step ${position + 1} · ${step.label}` : step.label,
      title: copy.title,
      body: copy.body,
      ...(copy.note !== undefined ? { note: copy.note } : {}),
      ...(step.nextLabel !== undefined ? { nextLabel: step.nextLabel } : {}),
      ...(step.stage !== undefined ? { stage: step.stage } : {}),
    };
  });
}

/**
 * Do two resolutions describe the same tour? Used to decide whether a re-resolve is worth taking —
 * comparing the rendered shape rather than object identity, so an equivalent re-run is a no-op
 * instead of a state write that restarts the measurement loop.
 */
export function sameSequence(a: readonly ResolvedStep[], b: readonly ResolvedStep[]): boolean {
  return (
    a.length === b.length &&
    a.every((step, i) => {
      const other = b[i];
      return (
        other !== undefined &&
        step.target === other.target &&
        step.eyebrow === other.eyebrow &&
        step.title === other.title &&
        step.body === other.body &&
        step.note === other.note
      );
    })
  );
}
