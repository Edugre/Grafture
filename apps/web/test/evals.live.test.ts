import { applyActions, emptySchema, parseCsv } from "@schema-studio/core";
import { describe, expect, it } from "vitest";

import { AnthropicBrowserProvider } from "../src/ai/AnthropicBrowserProvider.js";
import { buildInitialSchemaPrompt } from "../src/copilot/kickoff.js";

/**
 * Live-model eval: opt-in (set ANTHROPIC_API_KEY), never runs in CI. Asserts *structural*
 * properties of a real initial draft — the ones the prompt overhaul targets — not exact output:
 * the flattened orders file must be split by entity rather than mirrored one-table-per-file,
 * and every emitted action must apply cleanly through core's validator.
 *
 * Run: ANTHROPIC_API_KEY=sk-... pnpm --filter @schema-studio/web exec vitest run test/evals.live.test.ts
 */

const apiKey = process.env["ANTHROPIC_API_KEY"];

const FLATTENED_ORDERS = [
  "order_id,order_date,amount,customer_id,customer_name,customer_email",
  "O-1001,2026-01-05,19.99,C-01,Acme Corp,ops@acme.com",
  "O-1002,2026-01-06,42.50,C-01,Acme Corp,ops@acme.com",
  "O-1003,2026-01-07,7.25,C-02,Globex LLC,it@globex.com",
  "O-1004,2026-01-08,99.00,C-02,Globex LLC,it@globex.com",
  "O-1005,2026-01-09,15.75,C-03,Initech,help@initech.com",
].join("\n");

describe.runIf(Boolean(apiKey))("live eval: initial draft from a flattened export", () => {
  it(
    "splits the file by entity, applies cleanly, and sets primary keys",
    { timeout: 180_000 },
    async () => {
      const provider = new AnthropicBrowserProvider(apiKey ?? "");
      const sources = [parseCsv(FLATTENED_ORDERS, "orders.csv")];

      const result = await provider.propose(
        emptySchema(),
        sources,
        buildInitialSchemaPrompt({ name: "Orders eval", description: "" }),
      );

      const { schema, rejected } = applyActions(emptySchema(), result.actions);

      // Every emitted action must survive core validation.
      expect(rejected).toEqual([]);
      // Entity split: one flattened file must NOT become one mirrored table.
      expect(schema.tables.length).toBeGreaterThanOrEqual(2);
      expect(schema.tables.length).toBeLessThanOrEqual(4);
      // The doctrine requires keys before relationships.
      for (const table of schema.tables) {
        expect(table.fields.some((field) => field.pk)).toBe(true);
      }
      // Plan-then-act: the reply must state the grain analysis.
      expect(result.reply.toLowerCase()).toContain("one row");
    },
  );
});
