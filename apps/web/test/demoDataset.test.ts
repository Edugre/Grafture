import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { parseSource, type Source } from "@grafture/core";
import { describe, expect, it } from "vitest";

import { isDemoDataset } from "../src/onboarding/demoDataset.js";

function source(name: string, fields: string[]): Source {
  return {
    id: name,
    name,
    kind: name.endsWith(".json") ? "json" : "csv",
    fields: fields.map((field) => ({ name: field, type: "text" as const, samples: [] })),
  };
}

/** The bundled pair as `readAndParseFile` produces it: `Source.name` is the file name. */
const HEALTH_CENTERS = source("health_centers.csv", [
  "bhcmis_id",
  "site_name",
  "city",
  "state",
  "grant_number",
  "award_year",
]);
const COVERED_ENTITIES = source("covered_entities.json", [
  "id",
  "entity_name",
  "entity_type",
  "grant_num",
  "state",
]);

describe("isDemoDataset", () => {
  it("recognises the bundled pair", () => {
    expect(isDemoDataset([HEALTH_CENTERS, COVERED_ENTITIES])).toBe(true);
  });

  it("does not care about order or about extra files alongside it", () => {
    expect(isDemoDataset([COVERED_ENTITIES, HEALTH_CENTERS])).toBe(true);
    expect(isDemoDataset([source("notes.csv", ["x"]), HEALTH_CENTERS, COVERED_ENTITIES])).toBe(
      true,
    );
  });

  it("needs both halves — one on its own is not the dataset the copy describes", () => {
    expect(isDemoDataset([HEALTH_CENTERS])).toBe(false);
    expect(isDemoDataset([COVERED_ENTITIES])).toBe(false);
    expect(isDemoDataset([])).toBe(false);
  });

  it("is false for anyone else's files — the case the copy was lying to", () => {
    expect(
      isDemoDataset([source("sales.csv", ["id", "total"]), source("customers.json", ["id"])]),
    ).toBe(false);
  });

  it("needs the join columns, not just the file names", () => {
    // Someone with unrelated files that happen to be named this way would otherwise be told their
    // project holds HRSA sites joined on a grant number.
    const namesakeA = source("health_centers.csv", ["id", "name"]);
    const namesakeB = source("covered_entities.json", ["id", "label"]);

    expect(isDemoDataset([namesakeA, namesakeB])).toBe(false);
  });

  it("ignores case and matches the file stem, not the whole name", () => {
    expect(
      isDemoDataset([
        source("Health_Centers.CSV", ["GRANT_NUMBER"]),
        source("Covered_Entities.Json", ["Grant_Num"]),
      ]),
    ).toBe(true);
  });

  it("does not match a child source unnested from the JSON", () => {
    // `groupSources` names children `<parent>.<key>`; stripping one extension off
    // `covered_entities.json.addresses` leaves `covered_entities.json`, not `covered_entities`.
    const child = source("covered_entities.json.addresses", ["grant_num", "street"]);

    expect(isDemoDataset([HEALTH_CENTERS, child])).toBe(false);
    expect(isDemoDataset([HEALTH_CENTERS, COVERED_ENTITIES, child])).toBe(true);
  });
});

describe("against the files actually bundled", () => {
  // The fixtures above mirror `apps/web/public/demo/`, and a mirror drifts. This parses the real
  // files through the real parser, so renaming a demo column silently drops the tour back to
  // generic copy *and* fails here, rather than only the first.
  const demoDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../public/demo");
  const read = (file: string) => readFileSync(path.join(demoDir, file), "utf8");

  it("recognises the bundled pair as parsed by the app", () => {
    const sources = [
      ...parseSource({
        name: "health_centers.csv",
        kind: "csv",
        content: read("health_centers.csv"),
      }),
      ...parseSource({
        name: "covered_entities.json",
        kind: "json",
        content: read("covered_entities.json"),
      }),
    ];

    expect(isDemoDataset(sources)).toBe(true);
  });

  it("stops recognising it if either file is missing", () => {
    const onlyCsv = parseSource({
      name: "health_centers.csv",
      kind: "csv",
      content: read("health_centers.csv"),
    });

    expect(isDemoDataset(onlyCsv)).toBe(false);
  });
});
