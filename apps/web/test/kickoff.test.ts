import { describe, expect, it } from "vitest";

import { buildInitialSchemaPrompt } from "../src/copilot/kickoff.js";

describe("buildInitialSchemaPrompt", () => {
  it("always includes the drafting instruction", () => {
    const prompt = buildInitialSchemaPrompt({ name: "", description: "" });
    expect(prompt).toContain("Draft an initial relational schema");
    // No context block when neither field is provided.
    expect(prompt).not.toContain("Project:");
    expect(prompt).not.toContain("Goals:");
  });

  it("includes the project name when provided", () => {
    const prompt = buildInitialSchemaPrompt({ name: "Grant Reporting", description: "" });
    expect(prompt).toContain("Project: Grant Reporting");
    expect(prompt).not.toContain("Goals:");
  });

  it("includes the goals when a description is provided", () => {
    const prompt = buildInitialSchemaPrompt({ name: "", description: "join on org id" });
    expect(prompt).toContain("Goals: join on org id");
    expect(prompt).not.toContain("Project:");
  });

  it("includes both, trimmed", () => {
    const prompt = buildInitialSchemaPrompt({
      name: "  Reconcile  ",
      description: "  dedupe records  ",
    });
    expect(prompt).toContain("Project: Reconcile");
    expect(prompt).toContain("Goals: dedupe records");
  });
});
