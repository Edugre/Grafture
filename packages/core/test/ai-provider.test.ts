import { describe, expect, it } from "vitest";

import type { AiProvider } from "../src/ai/provider.js";

describe("AiProvider", () => {
  it("is a structural interface for propose()", async () => {
    const provider: AiProvider = {
      propose: async () => ({ reply: "stub", actions: [] }),
    };

    await expect(provider.propose({ tables: [], relationships: [] }, [], "hi")).resolves.toEqual({
      reply: "stub",
      actions: [],
    });
  });
});
