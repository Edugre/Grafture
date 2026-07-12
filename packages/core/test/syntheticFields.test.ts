import { describe, expect, it } from "vitest";

import type { Source } from "../src/parse/types.js";
import {
  detectCompositeKeys,
  detectFunctionalDependencies,
  detectJoinKeys,
  detectPrimaryKeys,
  detectSemanticTypes,
  detectValueSets,
} from "../src/detect/index.js";
import { parseJson } from "../src/index.js";

/** PR-1: synthetic surrogate columns are structural links — no detector may surface them. */
describe("synthetic field exclusion", () => {
  const [parent, child] = parseJson(
    JSON.stringify(
      Array.from({ length: 30 }, (_, i) => ({
        grantNumber: `H80CS${100 + i}`,
        state: i % 3 === 0 ? "MA" : "NY",
        npiNumbers: [{ npiNumber: `${1000000000 + i}` }],
      })),
    ),
    "opais.json",
  );
  const sources = [parent, child].filter((entry): entry is Source => entry !== undefined);

  it("never proposes _rowId/_parentId as a primary key", () => {
    const pks = detectPrimaryKeys(sources);
    const fields = pks.map((candidate) => candidate.field);
    expect(fields).not.toContain("_rowId");
    expect(fields).not.toContain("_parentId");
    // The real semantic key still surfaces.
    expect(fields).toContain("grantNumber");
  });

  it("never joins on a surrogate index column", () => {
    // _rowId (0..29) and _parentId (0..29) would trivially "join" — must be excluded.
    const joins = detectJoinKeys(sources);
    for (const candidate of joins) {
      expect(candidate.left.field).not.toMatch(/^_(row|parent)Id$/);
      expect(candidate.right.field).not.toMatch(/^_(row|parent)Id$/);
    }
  });

  it("never reports a surrogate as a value set, semantic type, composite key, or FD member", () => {
    const surrogate = /^_(row|parent)Id$/;
    for (const candidate of detectValueSets(sources)) {
      expect(candidate.field).not.toMatch(surrogate);
    }
    for (const finding of detectSemanticTypes(sources)) {
      expect(finding.field).not.toMatch(surrogate);
    }
    for (const candidate of detectCompositeKeys(sources)) {
      expect(candidate.fields[0]).not.toMatch(surrogate);
      expect(candidate.fields[1]).not.toMatch(surrogate);
    }
    for (const candidate of detectFunctionalDependencies(sources)) {
      expect(candidate.determinant).not.toMatch(surrogate);
      for (const dependent of candidate.dependents) {
        expect(dependent).not.toMatch(surrogate);
      }
    }
  });
});
