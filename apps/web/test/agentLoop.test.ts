import type { ConversationTurn, CopilotStatus } from "@grafture/core";
import { describe, expect, it, vi } from "vitest";

import {
  type ApplyFn,
  type ProposeFn,
  type RejectedEntry,
  buildRejectionFeedback,
  runCopilotLoop,
} from "../src/copilot/agentLoop.js";

type Round = {
  reply?: string;
  actions?: unknown[];
  status?: CopilotStatus;
  applied?: string[];
  rejected?: RejectedEntry[];
};

/** Build propose/apply fakes that replay a scripted sequence of rounds. */
function scripted(rounds: Round[]): {
  propose: ProposeFn;
  apply: ApplyFn;
  proposeCalls: Array<{ message: string; history: ConversationTurn[] }>;
} {
  let i = 0;
  const proposeCalls: Array<{ message: string; history: ConversationTurn[] }> = [];

  const propose: ProposeFn = async (message, history) => {
    proposeCalls.push({ message, history: [...history] });
    const round = rounds[Math.min(i, rounds.length - 1)];
    return {
      reply: round?.reply ?? `reply ${i}`,
      actions: round?.actions ?? [],
      status: round?.status ?? "needs_revision",
    };
  };

  const apply: ApplyFn = () => {
    const round = rounds[Math.min(i, rounds.length - 1)];
    i += 1;
    return { applied: round?.applied ?? [], rejected: round?.rejected ?? [] };
  };

  return { propose, apply, proposeCalls };
}

const reject = (reason: string): RejectedEntry => ({ action: { op: "x" }, reason });

describe("runCopilotLoop", () => {
  it("completes after a clean apply", async () => {
    const { propose, apply } = scripted([{ status: "complete" }]);

    const result = await runCopilotLoop({ message: "go", history: [], propose, apply });

    expect(result.outcome).toBe("complete");
    expect(result.steps).toHaveLength(1);
  });

  it("retries on rejection then completes, feeding reasons back", async () => {
    const { propose, apply, proposeCalls } = scripted([
      { rejected: [reject("table 'users' not found")] },
      { status: "complete" },
    ]);

    const result = await runCopilotLoop({ message: "link them", history: [], propose, apply });

    expect(result.outcome).toBe("complete");
    expect(result.steps).toHaveLength(2);
    // The second call's message is the rejection feedback carrying the reason.
    expect(proposeCalls[1]?.message).toContain("table 'users' not found");
    // And it carries the prior turn as history.
    expect(proposeCalls[1]?.history.at(-1)?.role).toBe("assistant");
  });

  it("runs a confirmation round after a successful apply, then completes", async () => {
    const { propose, apply, proposeCalls } = scripted([
      { applied: ["link a → b"], status: "needs_revision", reply: "Linking now." },
      { status: "complete", reply: "Linked a to b." },
    ]);

    const result = await runCopilotLoop({ message: "link them", history: [], propose, apply });

    expect(result.outcome).toBe("complete");
    expect(result.steps).toHaveLength(2);
    // Second round is the observe-then-confirm turn.
    expect(proposeCalls[1]?.message).toContain("applied to the schema successfully");
    expect(result.steps[1]?.reply).toBe("Linked a to b.");
  });

  it("does not spin when a needs_revision round changes nothing", async () => {
    const { propose, apply } = scripted([{ status: "needs_revision", applied: [], reply: "hm" }]);

    const result = await runCopilotLoop({ message: "go", history: [], propose, apply });

    expect(result.outcome).toBe("complete");
    expect(result.steps).toHaveLength(1);
  });

  it("stops when the model reports blocked", async () => {
    const { propose, apply } = scripted([
      { status: "blocked", reply: "Formats are incompatible.", rejected: [reject("bad join")] },
    ]);

    const result = await runCopilotLoop({ message: "join", history: [], propose, apply });

    expect(result.outcome).toBe("blocked");
    expect(result.steps).toHaveLength(1);
  });

  it("stalls when the same rejections repeat", async () => {
    const { propose, apply } = scripted([
      { rejected: [reject("same problem")] },
      { rejected: [reject("same problem")] },
    ]);

    const result = await runCopilotLoop({ message: "go", history: [], propose, apply });

    expect(result.outcome).toBe("stalled");
    expect(result.steps).toHaveLength(2);
  });

  it("exhausts the iteration cap when rejections keep changing", async () => {
    let n = 0;
    const propose: ProposeFn = async () => ({
      reply: "r",
      actions: [],
      status: "needs_revision",
    });
    const apply: ApplyFn = () => ({ applied: [], rejected: [reject(`problem ${n++}`)] });

    const result = await runCopilotLoop({
      message: "go",
      history: [],
      propose,
      apply,
      maxIterations: 3,
    });

    expect(result.outcome).toBe("exhausted");
    expect(result.steps).toHaveLength(3);
  });

  it("stops before proposing when cancelled", async () => {
    const propose = vi.fn<ProposeFn>(async () => ({
      reply: "r",
      actions: [],
      status: "needs_revision",
    }));
    const apply: ApplyFn = () => ({ applied: [], rejected: [] });

    const result = await runCopilotLoop({
      message: "go",
      history: [],
      propose,
      apply,
      isCancelled: () => true,
    });

    expect(result.outcome).toBe("cancelled");
    expect(propose).not.toHaveBeenCalled();
  });
});

describe("buildRejectionFeedback", () => {
  it("lists each reason and instructs how to proceed", () => {
    const text = buildRejectionFeedback([
      reject("field 'email' already exists"),
      reject("no table"),
    ]);

    expect(text).toContain("- field 'email' already exists");
    expect(text).toContain("- no table");
    expect(text).toContain("blocked");
  });
});

/* PR-5 (GAP E): the copilot path — a stubbed proposal carrying junction scaffolding flows
 * through the real store's validated apply path and lands as a junction table + two 1:N FKs. */
describe("N:M junction proposals through the store", () => {
  it("applies a junction table with composite PK and two 1:N relationships", async () => {
    const { createSchemaStore } = await import("../src/store/schemaStore.js");
    let counter = 0;
    const store = createSchemaStore({ makeId: () => `id-${(counter += 1)}` });

    const junctionActions = [
      { op: "add_table", name: "students" },
      { op: "add_field", table: "students", name: "course_code", type: "text" },
      { op: "add_table", name: "courses" },
      { op: "add_field", table: "courses", name: "course_code", type: "text" },
      { op: "add_table", name: "students_courses" },
      { op: "add_field", table: "students_courses", name: "student_code", type: "text", fk: true },
      { op: "add_field", table: "students_courses", name: "course_code", type: "text", fk: true },
      { op: "set_pk", table: "students_courses", field: "student_code", pk: true },
      { op: "set_pk", table: "students_courses", field: "course_code", pk: true },
      {
        op: "add_relationship",
        from_table: "students",
        from_field: "course_code",
        to_table: "students_courses",
        to_field: "student_code",
        cardinality: "1:N",
      },
      {
        op: "add_relationship",
        from_table: "courses",
        from_field: "course_code",
        to_table: "students_courses",
        to_field: "course_code",
        cardinality: "1:N",
      },
    ];

    const propose: ProposeFn = async () => ({
      reply: "Junction it is.",
      actions: junctionActions,
      status: "complete",
    });
    const apply: ApplyFn = (actions) => {
      const result = store.getState().runActions(actions);
      return { applied: result.applied.map((entry) => entry.op), rejected: result.rejected };
    };

    const result = await runCopilotLoop({ message: "model the N:M", history: [], propose, apply });

    expect(result.outcome).toBe("complete");
    const schema = store.getState().schema;
    const junction = schema.tables.find((table) => table.name === "students_courses");
    expect(junction).toBeDefined();
    // Composite key: both junction columns are PK (and FK).
    expect(junction?.fields.filter((field) => field.pk)).toHaveLength(2);
    expect(junction?.fields.every((field) => field.fk)).toBe(true);
    // Two 1:N edges into the junction; no direct N:M edge anywhere.
    expect(schema.relationships).toHaveLength(2);
    expect(schema.relationships.every((rel) => rel.cardinality === "1:N")).toBe(true);
    expect(schema.relationships.every((rel) => rel.toTable === junction?.id)).toBe(true);
  });
});
