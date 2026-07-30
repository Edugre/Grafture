import { describe, expect, it } from "vitest";

import { requiredStringArgs } from "../src/copilot/toolArgs.js";
import { INSPECT_SOURCE_TOOL } from "../src/copilot/inspectSourceTool.js";
import { PROBE_JOIN_TOOL } from "../src/copilot/probeJoinTool.js";

describe("requiredStringArgs", () => {
  it("reads every required argument declared by the tool", () => {
    expect(
      requiredStringArgs(PROBE_JOIN_TOOL, {
        left_source: "a.csv",
        left_field: "id",
        right_source: "b.csv",
        right_field: "a_id",
      }),
    ).toEqual({
      left_source: "a.csv",
      left_field: "id",
      right_source: "b.csv",
      right_field: "a_id",
    });
  });

  it("keys the result off input_schema.required, not hand-written literals", () => {
    // The guard against declaration/runner drift: the returned keys ARE the declared ones, so
    // a rename in the declaration can't leave a runner silently reading "" from a stale key.
    // The type-level half of this is enforced by tsc — renaming a property makes the stale
    // accessor in runProbeJoin a compile error.
    const args = requiredStringArgs(INSPECT_SOURCE_TOOL, { source: "a.csv", field: "id" });
    expect(Object.keys(args).sort()).toEqual([...INSPECT_SOURCE_TOOL.input_schema.required].sort());
  });

  it("coerces a missing or non-string argument to an empty string", () => {
    // Deliberate: the model does omit arguments, and the runners turn "" into an error string
    // handed back for self-correction rather than throwing mid-loop.
    expect(requiredStringArgs(INSPECT_SOURCE_TOOL, { source: "a.csv" })).toEqual({
      source: "a.csv",
      field: "",
    });
    expect(requiredStringArgs(INSPECT_SOURCE_TOOL, { source: 42, field: null })).toEqual({
      source: "",
      field: "",
    });
  });

  it("tolerates a non-object payload", () => {
    for (const input of [undefined, null, "nope", 7, []]) {
      expect(requiredStringArgs(INSPECT_SOURCE_TOOL, input)).toEqual({ source: "", field: "" });
    }
  });
});
