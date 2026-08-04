import { describe, expect, it } from "vitest";

import {
  MODAL_MAX_HEIGHT,
  MODAL_WIDTH,
  SPOTLIGHT_PAD,
  formatCounter,
  modalWidth,
  placeModal,
  sameRect,
  spotlightRect,
} from "../src/onboarding/placement.js";
import { TOUR_STEPS, resolveSteps, type TourContext } from "../src/onboarding/steps.js";

const SHELL = { left: 40, top: 20, width: 1440, height: 900 };

describe("spotlightRect", () => {
  it("makes the target shell-relative and inflates it by the pad", () => {
    const spot = spotlightRect({ left: 140, top: 120, width: 200, height: 60 }, SHELL);

    expect(spot).toEqual({
      left: 100 - SPOTLIGHT_PAD,
      top: 100 - SPOTLIGHT_PAD,
      width: 200 + SPOTLIGHT_PAD * 2,
      height: 60 + SPOTLIGHT_PAD * 2,
    });
  });

  it("keeps a target that starts above the shell negative rather than clamping it", () => {
    // A card scrolled half out of the sources rail should have its ring clipped by the shell, not
    // resized into a box that no longer traces the element.
    const spot = spotlightRect({ left: 40, top: 0, width: 240, height: 80 }, SHELL);

    expect(spot.top).toBe(-20 - SPOTLIGHT_PAD);
    expect(spot.height).toBe(80 + SPOTLIGHT_PAD * 2);
  });
});

describe("placeModal", () => {
  it("centers an untargeted step in the upper third", () => {
    expect(placeModal(null, { width: 1440, height: 900 })).toEqual({
      left: (1440 - MODAL_WIDTH) / 2,
      top: 300,
      width: MODAL_WIDTH,
    });
  });

  it("prefers the right of the spotlight when there is room", () => {
    const spot = { left: 16, top: 120, width: 280, height: 90 };

    expect(placeModal(spot, { width: 1440, height: 900 })).toEqual({
      left: 320,
      top: 120,
      width: MODAL_WIDTH,
    });
  });

  it("falls to the left when the right side cannot hold the card", () => {
    // 1440 - (900 + 300) = 240 of right room; the left has 900.
    const spot = { left: 900, top: 200, width: 300, height: 90 };

    expect(placeModal(spot, { width: 1440, height: 900 })).toEqual({
      left: 900 - 24 - MODAL_WIDTH,
      top: 200,
      width: MODAL_WIDTH,
    });
  });

  it("centers under a spotlight too wide for either side, clamped off the shell edges", () => {
    const spot = { left: 200, top: 100, width: 1000, height: 90 };

    expect(placeModal(spot, { width: 1440, height: 900 })).toEqual({
      left: 502,
      top: 100,
      width: MODAL_WIDTH,
    });
  });

  it("lifts the card when it would run past the shell's bottom", () => {
    const spot = { left: 16, top: 800, width: 200, height: 60 };

    expect(placeModal(spot, { width: 1440, height: 900 })).toEqual({
      left: 240,
      top: 900 - 24 - MODAL_MAX_HEIGHT,
      width: MODAL_WIDTH,
    });
  });

  it("never pushes the card off the top of a shell shorter than the card", () => {
    const spot = { left: 16, top: 40, width: 200, height: 60 };

    expect(placeModal(spot, { width: 1440, height: 200 }).top).toBe(24);
  });

  it("narrows the card, and keeps it on screen, when the shell can't hold it", () => {
    const spot = { left: 40, top: 60, width: 100, height: 40 };
    const placed = placeModal(spot, { width: 320, height: 900 });

    expect(placed.left).toBe(24);
    expect(placed.width).toBe(320 - 48);
    // The whole card — including the Next button on its right edge — stays inside the shell.
    expect(placed.left + placed.width).toBeLessThanOrEqual(320);
  });

  it("keeps the primary button inside the shell at every phone width", () => {
    // The regression this guards: a fixed 396px card at a 375px shell put the Next button at
    // x=400, and the overlay clips rather than scrolls — so the primary action vanished.
    const spot = { left: 8, top: 100, width: 200, height: 48 };

    for (const width of [320, 375, 414, 768]) {
      const placed = placeModal(spot, { width, height: 800 });
      expect(placed.left, `left at ${width}px`).toBeGreaterThanOrEqual(0);
      expect(placed.left + placed.width, `right edge at ${width}px`).toBeLessThanOrEqual(width);
    }
  });
});

describe("modalWidth", () => {
  it("holds the handoff measure when the shell can afford it, and gives it up when it can't", () => {
    expect(modalWidth(1440)).toBe(MODAL_WIDTH);
    expect(modalWidth(444)).toBe(MODAL_WIDTH);
    expect(modalWidth(443)).toBe(443 - 48);
    expect(modalWidth(375)).toBe(327);
    expect(modalWidth(0)).toBe(0);
  });
});

describe("formatCounter", () => {
  it("zero-pads both sides so the counter never changes width", () => {
    expect(formatCounter(0, 10)).toBe("01 / 10");
    expect(formatCounter(9, 10)).toBe("10 / 10");
  });
});

describe("sameRect", () => {
  it("treats sub-pixel drift as unchanged and a real move as changed", () => {
    const base = { left: 10, top: 10, width: 100, height: 40 };

    expect(sameRect(base, { ...base, left: 10.2 })).toBe(true);
    expect(sameRect(base, { ...base, left: 11 })).toBe(false);
    expect(sameRect(null, null)).toBe(true);
    expect(sameRect(null, base)).toBe(false);
  });
});

const LOADED: TourContext = { hasSources: true, hasRelationships: true, hasSuggestions: true };
const EMPTY: TourContext = { hasSources: false, hasRelationships: false, hasSuggestions: false };

describe("TOUR_STEPS", () => {
  it("is the ten steps the tutorial documents, opening and closing untargeted", () => {
    expect(TOUR_STEPS).toHaveLength(10);
    expect(TOUR_STEPS[0]?.target).toBeNull();
    expect(TOUR_STEPS[9]?.target).toBeNull();
  });

  it("overrides the button label only on the first and last steps", () => {
    const labelled = TOUR_STEPS.filter((step) => step.nextLabel !== undefined);

    expect(labelled.map((step) => step.nextLabel)).toEqual(["Start", "Start building"]);
  });

  it("numbers every step except the two bookends", () => {
    expect(TOUR_STEPS.map((step) => step.numbered)).toEqual([
      false,
      true,
      true,
      true,
      true,
      true,
      true,
      true,
      true,
      false,
    ]);
  });

  it("stages a rail open for every step whose anchor lives inside one", () => {
    // Both side panels open collapsed, so a step pointing into one that forgot to say so would
    // silently drop on first run — the failure this assertion exists to catch.
    const railed = new Map<string, "sources" | "copilot">([
      ["source-card", "sources"],
      ["sources-empty", "sources"],
      ["build-table", "sources"],
      ["suggestions", "copilot"],
      ["chat", "copilot"],
    ]);

    for (const step of TOUR_STEPS) {
      for (const target of [step.target, step.variant?.target]) {
        const required = target == null ? undefined : railed.get(target);
        if (required) {
          expect(step.stage?.[required], `${step.label} must open the ${required} rail`).toBe(true);
        }
      }
    }
  });

  it("keeps every step's copy non-empty, variants included", () => {
    for (const step of TOUR_STEPS) {
      expect(step.label.length).toBeGreaterThan(0);
      expect(step.title.length).toBeGreaterThan(0);
      expect(step.body.length).toBeGreaterThan(0);
      if (step.variant) {
        expect(step.variant.title.length).toBeGreaterThan(0);
        expect(step.variant.body.length).toBeGreaterThan(0);
      }
    }
  });

  it("gives every requirement either a variant or a deliberate drop", () => {
    // Not an assertion about which — just that no step carries a requirement by accident. A step
    // that requires something and has no variant is stating "drop me", and that has to be a choice.
    const required = TOUR_STEPS.filter((step) => step.requires !== undefined);

    expect(required.map((step) => [step.label, step.variant !== undefined])).toEqual([
      ["Welcome", true],
      ["Sources", true],
      ["Build", false],
      ["Relationships", false],
      ["Suggestions", false],
    ]);
  });
});

describe("resolveSteps", () => {
  it("runs all ten, verbatim, on a project that has everything", () => {
    const resolved = resolveSteps(LOADED);

    expect(resolved).toHaveLength(10);
    expect(resolved.map((step) => step.eyebrow)).toEqual([
      "Welcome",
      "Step 2 \u00b7 Sources",
      "Step 3 \u00b7 Build",
      "Step 4 \u00b7 Canvas",
      "Step 5 \u00b7 Relationships",
      "Step 6 \u00b7 Suggestions",
      "Step 7 \u00b7 Copilot",
      "Step 8 \u00b7 Provenance",
      "Step 9 \u00b7 Export",
      "Done",
    ]);
    // The handoff's copy, untouched, whenever the project can carry it.
    expect(resolved[0]?.title).toBe(TOUR_STEPS[0]?.title);
    expect(resolved[0]?.note).toBe("health_centers.csv \u00b7 covered_entities.json");
    expect(resolved[1]?.body).toBe(TOUR_STEPS[1]?.body);
  });

  it("drops to seven on an empty project, renumbering as it goes", () => {
    const resolved = resolveSteps(EMPTY);

    expect(resolved.map((step) => step.eyebrow)).toEqual([
      "Welcome",
      "Step 2 \u00b7 Sources",
      "Step 3 \u00b7 Canvas",
      "Step 4 \u00b7 Copilot",
      "Step 5 \u00b7 Provenance",
      "Step 6 \u00b7 Export",
      "Done",
    ]);
  });

  it("never leaves a step pointing at an anchor the project can't have", () => {
    const resolved = resolveSteps(EMPTY);
    const targets = resolved.map((step) => step.target);

    expect(targets).not.toContain("source-card");
    expect(targets).not.toContain("build-table");
    expect(targets).not.toContain("relationship");
    expect(targets).not.toContain("suggestions");
    // …and the Sources step still points at something real: the dropzone.
    expect(targets).toContain("sources-empty");
  });

  it("swaps the welcome copy that claims files are already loaded", () => {
    const loaded = resolveSteps(LOADED)[0];
    const empty = resolveSteps(EMPTY)[0];

    expect(loaded?.body).toContain("This project already holds");
    expect(loaded?.note).toBeDefined();
    expect(empty?.body).not.toContain("already holds");
    // The authored note names two files that aren't there — a variant without one drops it.
    expect(empty?.note).toBeUndefined();
    expect(empty?.nextLabel).toBe("Start");
  });

  it("resolves each requirement independently", () => {
    // Sources loaded, nothing joined yet, detectors have findings: only Relationships drops.
    const resolved = resolveSteps({
      hasSources: true,
      hasRelationships: false,
      hasSuggestions: true,
    });

    expect(resolved).toHaveLength(9);
    expect(resolved.map((step) => step.target)).not.toContain("relationship");
    expect(resolved.map((step) => step.target)).toContain("suggestions");
  });

  it("keeps the eyebrow numeral and the counter in agreement in every shape", () => {
    // The regression this guards: dropping step 5 used to leave "Step 6 \u00b7 Suggestions" sitting
    // above a counter reading "05 / 09".
    for (const context of [
      LOADED,
      EMPTY,
      { hasSources: true, hasRelationships: false, hasSuggestions: false },
      { hasSources: true, hasRelationships: true, hasSuggestions: false },
    ]) {
      const resolved = resolveSteps(context);
      resolved.forEach((step, position) => {
        const numeral = /^Step (\d+) \u00b7 /.exec(step.eyebrow)?.[1];
        if (numeral) {
          expect(Number(numeral), `${step.eyebrow} at position ${position}`).toBe(position + 1);
        }
      });
      expect(resolved[0]?.eyebrow).toBe("Welcome");
      expect(resolved[resolved.length - 1]?.eyebrow).toBe("Done");
    }
  });
});
