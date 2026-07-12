import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  detectFunctionalDependencies,
  detectJoinKeys,
  detectPrimaryKeys,
  probeJoin,
} from "../src/detect/index.js";
import { parseCsv, parseJson } from "../src/index.js";

const fixturesDir = join(dirname(fileURLToPath(import.meta.url)), "fixtures");
const read = (name: string): string => readFileSync(join(fixturesDir, name), "utf8");

/**
 * §6 acceptance: the checked-in HRSA+OPAIS miniatures (200 CSV rows / 150 JSON records —
 * sized in-window so these hold at either scan cap). The four criteria the whole upgrade is
 * judged by: (1) an org/site split is evidenced by an FD on the CSV, (2) the JSON's repeating
 * sub-entities become child sources, (3) both the grant bridge AND the NPI bridge surface
 * (the latter with a leading-zero note), (4) the Medicare look-alike is rejected.
 */
describe("HRSA+OPAIS miniature acceptance", () => {
  const hrsa = parseCsv(read("hrsa_mini.csv"), "hrsa_mini.csv");
  const opaisSources = parseJson(read("opais_mini.json"), "opais_mini.json");
  const sources = [hrsa, ...opaisSources];

  it("(1) evidences the org/site split: the org id determines the org-level columns", () => {
    const fds = detectFunctionalDependencies([hrsa]);
    const orgFd = fds.find((candidate) => candidate.determinant === "Grantee Org ID");

    expect(orgFd).toBeDefined();
    expect(orgFd?.dependents).toEqual(
      expect.arrayContaining(["Grantee Org Name", "Grantee State", "Grantee Phone"]),
    );
    expect(orgFd?.groups).toBe(40);
  });

  it("(1b) proposes the real semantic PK for each grain, not a surrogate", () => {
    const pks = detectPrimaryKeys(sources);
    const fields = pks.map((candidate) => `${candidate.sourceName}.${candidate.field}`);

    expect(fields).toContain("hrsa_mini.csv.Health Center Number");
    expect(fields).toContain("opais_mini.json.grantNumber");
    expect(fields.some((field) => field.endsWith("._rowId"))).toBe(false);
  });

  it("(2) unnests the repeating sub-entities into child sources", () => {
    expect(opaisSources.map((source) => source.name)).toEqual([
      "opais_mini.json",
      "opais_mini.json.npiNumbers",
      "opais_mini.json.medicaidNumbers",
      "opais_mini.json.contractPharmacies",
    ]);

    const npiChild = opaisSources[1];
    expect(npiChild?.fields.map((field) => field.name)).toEqual([
      "npiNumber",
      "npiState",
      "_parentId",
    ]);
    // 30 parents carry two elements, 120 carry one.
    expect(npiChild?.rowCount).toBe(180);
    expect(npiChild?.derivedFrom).toEqual({
      parentId: opaisSources[0]?.id,
      arrayField: "npiNumbers",
    });
  });

  it("(3) surfaces the grant bridge AND the unnested NPI bridge with a leading-zero note", () => {
    const joins = detectJoinKeys(sources);
    const label = (candidate: (typeof joins)[number]) =>
      `${candidate.left.sourceName}.${candidate.left.field} ↔ ${candidate.right.sourceName}.${candidate.right.field}`;
    const labels = joins.map(label);

    expect(labels).toContain("hrsa_mini.csv.Health Center Number ↔ opais_mini.json.grantNumber");

    const npiBridge = joins.find(
      (candidate) =>
        candidate.left.field === "FQHC Site NPI Number" && candidate.right.field === "npiNumber",
    );
    expect(npiBridge).toBeDefined();
    // The FK shape: every shared value, 50 of the child's 100 distinct NPIs, all inside the
    // CSV column — admitted by containment (Jaccard 50/250 = 0.2 sits under the 0.3 gate).
    expect(npiBridge?.sharedValues).toBe(50);
    expect(npiBridge?.normalizedOverlap).toBeLessThan(0.3);
    expect(Math.max(npiBridge?.containmentLeft ?? 0, npiBridge?.containmentRight ?? 0)).toBe(0.5);
    expect(npiBridge?.formatMismatch?.issues).toContain("leading_zeros");
  });

  it("(4) rejects the Medicare look-alike: no join, and a probe shows zero containment", () => {
    const joins = detectJoinKeys(sources);
    for (const candidate of joins) {
      expect(candidate.left.field).not.toBe("Medicare Number");
      expect(candidate.right.field).not.toBe("Medicare Number");
    }

    const probe = probeJoin(sources, {
      left: { source: "hrsa_mini.csv", field: "Medicare Number" },
      right: { source: "opais_mini.json.medicaidNumbers", field: "medicaidNumber" },
    });
    if (!probe.ok) {
      throw new Error(probe.error);
    }
    expect(probe.shared).toBe(0);
    expect(probe.containmentLeft).toBe(0);
  });

  it("keeps both bridges inside the top-8 findings window the prompt renders", () => {
    const joins = detectJoinKeys(sources).slice(0, 8);
    const fields = joins.flatMap((candidate) => [candidate.left.field, candidate.right.field]);

    expect(fields).toContain("grantNumber");
    expect(fields).toContain("npiNumber");
  });
});
