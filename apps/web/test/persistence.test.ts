import type { Schema, Source } from "@grafture/core";
import { describe, expect, it } from "vitest";

import { MemoryKeyValueStore } from "../src/persistence/kv.js";
import {
  deleteProjectRecord,
  getActiveProjectId,
  listProjectSummaries,
  listProjects,
  loadProjectRecord,
  saveProjectRecord,
  setActiveProjectId,
} from "../src/persistence/projectStore.js";
import {
  parseProjectFile,
  serializeProjectFile,
  toProjectFile,
  validateProjectRecord,
} from "../src/persistence/serialize.js";
import { PROJECT_FILE_KIND, type ProjectRecord } from "../src/persistence/types.js";

function sampleSchema(): Schema {
  return {
    tables: [
      {
        id: "t1",
        name: "users",
        x: 0,
        y: 0,
        fields: [{ id: "f1", name: "id", type: "int", pk: true, fk: false }],
      },
    ],
    relationships: [],
  };
}

function sampleSource(): Source {
  return {
    id: "s1",
    name: "users.csv",
    kind: "csv",
    fields: [{ name: "id", type: "int", samples: ["1", "2"] }],
  };
}

function record(id: string, overrides: Partial<ProjectRecord> = {}): ProjectRecord {
  return {
    id,
    name: id,
    createdAt: 1,
    updatedAt: 1,
    schema: sampleSchema(),
    sources: [sampleSource()],
    chat: [],
    ...overrides,
  };
}

describe("projectStore", () => {
  it("saves, loads, and round-trips a record without aliasing the stored value", async () => {
    const kv = new MemoryKeyValueStore();
    await saveProjectRecord(kv, record("a"));

    const loaded = await loadProjectRecord(kv, "a");
    expect(loaded?.name).toBe("a");
    expect(loaded?.schema.tables[0]?.name).toBe("users");

    // Mutating the loaded copy must not change what is persisted.
    loaded!.schema.tables[0]!.name = "mutated";
    const reloaded = await loadProjectRecord(kv, "a");
    expect(reloaded?.schema.tables[0]?.name).toBe("users");
  });

  it("lists projects most-recently-updated first", async () => {
    const kv = new MemoryKeyValueStore();
    await saveProjectRecord(kv, record("old", { updatedAt: 10 }));
    await saveProjectRecord(kv, record("new", { updatedAt: 30 }));
    await saveProjectRecord(kv, record("mid", { updatedAt: 20 }));

    const list = await listProjects(kv);
    expect(list.map((meta) => meta.id)).toEqual(["new", "mid", "old"]);
    // Metadata only — no heavy body.
    expect(list[0]).not.toHaveProperty("schema");
  });

  it("sums source row counts into the summary only when every source has one", async () => {
    const kv = new MemoryKeyValueStore();
    await saveProjectRecord(
      kv,
      record("all-known", {
        sources: [
          { ...sampleSource(), id: "s1", rowCount: 120 },
          { ...sampleSource(), id: "s2", name: "b.csv", rowCount: 30 },
        ],
        updatedAt: 20,
      }),
    );
    await saveProjectRecord(
      kv,
      record("mixed", {
        sources: [
          { ...sampleSource(), id: "s1", rowCount: 120 },
          { ...sampleSource(), id: "s2", name: "legacy.csv" }, // parsed before rowCount existed
        ],
        updatedAt: 10,
      }),
    );

    const [allKnown, mixed] = await listProjectSummaries(kv);
    expect(allKnown?.rowCount).toBe(150);
    // A total over a legacy source would be a confident undercount — omit it instead.
    expect(mixed?.rowCount).toBeUndefined();
  });

  it("deletes a project", async () => {
    const kv = new MemoryKeyValueStore();
    await saveProjectRecord(kv, record("a"));
    await saveProjectRecord(kv, record("b"));

    await deleteProjectRecord(kv, "a");

    expect(await loadProjectRecord(kv, "a")).toBeUndefined();
    expect((await listProjects(kv)).map((meta) => meta.id)).toEqual(["b"]);
  });

  it("tracks the active project id", async () => {
    const kv = new MemoryKeyValueStore();
    expect(await getActiveProjectId(kv)).toBeUndefined();
    await setActiveProjectId(kv, "a");
    expect(await getActiveProjectId(kv)).toBe("a");
  });
});

describe("validateProjectRecord (activate-path guard)", () => {
  it("accepts a well-formed record", () => {
    expect(validateProjectRecord(record("a"))).toEqual({ ok: true });
  });

  it("rejects a record whose stored schema is invalid", () => {
    const bad = record("a", {
      schema: { tables: [{ id: "x" }], relationships: [] } as unknown as Schema,
    });
    expect(validateProjectRecord(bad)).toEqual({
      ok: false,
      error: "its stored schema is invalid",
    });
  });

  it("rejects a record with an invalid stored source", () => {
    const bad = record("a", { sources: [{ id: "s1", name: "x" } as unknown as Source] });
    expect(validateProjectRecord(bad)).toEqual({
      ok: false,
      error: "one of its stored sources is invalid",
    });
  });

  it("rejects a record with corrupt stored chat — activation and import enforce one contract", () => {
    const bad = record("a", {
      chat: [{ id: "m1", role: "wizard", text: "hi" } as unknown as ProjectRecord["chat"][number]],
    });
    expect(validateProjectRecord(bad)).toEqual({
      ok: false,
      error: "its stored chat history is invalid",
    });
  });
});

describe("project file serialization", () => {
  it("round-trips a valid project file", () => {
    const json = serializeProjectFile({
      name: "My project",
      schema: sampleSchema(),
      sources: [sampleSource()],
      chat: [],
    });

    const result = parseProjectFile(json);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.file.kind).toBe(PROJECT_FILE_KIND);
      expect(result.file.name).toBe("My project");
      expect(result.file.schema.tables[0]?.name).toBe("users");
      expect(result.file.sources[0]?.id).toBe("s1");
    }
  });

  it("strips sampleRows from the shareable export but keeps per-column digests", () => {
    const source = {
      ...sampleSource(),
      sampleRows: [
        ["1", "a@x.com"],
        ["2", "b@y.org"],
      ],
    };

    const file = toProjectFile({ name: "P", schema: sampleSchema(), sources: [source], chat: [] });

    // Aligned raw row tuples are a cross-column correlation leak in a file meant to be shared.
    expect(file.sources[0]?.sampleRows).toBeUndefined();
    expect(file.sources[0]?.fields).toEqual(source.fields);
    // The in-memory source the app keeps using is untouched.
    expect(source.sampleRows).toHaveLength(2);
  });

  it("round-trips chat history", () => {
    const json = serializeProjectFile({
      name: "With chat",
      schema: sampleSchema(),
      sources: [],
      chat: [
        { id: "m1", role: "user", text: "link these on grant_no" },
        { id: "m2", role: "assistant", text: "Done.", applied: ["Added relationship"] },
      ],
    });

    const result = parseProjectFile(json);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.file.chat).toHaveLength(2);
      expect(result.file.chat[1]).toMatchObject({
        role: "assistant",
        applied: ["Added relationship"],
      });
    }
  });

  it("imports a v1 file without chat, defaulting to an empty conversation", () => {
    const v1 = {
      kind: PROJECT_FILE_KIND,
      version: 1,
      name: "Legacy",
      schema: sampleSchema(),
      sources: [sampleSource()],
    };
    const result = parseProjectFile(JSON.stringify(v1));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.file.chat).toEqual([]);
    }
  });

  it("rejects a malformed chat message instead of dropping it", () => {
    const file = {
      ...toProjectFile({ name: "bad", schema: sampleSchema(), sources: [], chat: [] }),
      chat: [{ id: "m1", role: "wizard", text: "hi" }],
    };
    const result = parseProjectFile(JSON.stringify(file));
    expect(result).toEqual({ ok: false, error: "Project file has an invalid chat message." });
  });

  it("rejects non-JSON input", () => {
    const result = parseProjectFile("not json {");
    expect(result).toEqual({ ok: false, error: "File is not valid JSON." });
  });

  it("rejects files without the project marker", () => {
    const result = parseProjectFile(JSON.stringify({ schema: sampleSchema(), sources: [] }));
    expect(result).toEqual({ ok: false, error: "Not a Grafture project file." });
  });

  it("rejects a structurally invalid schema instead of loading it partially", () => {
    const file = {
      ...toProjectFile({ name: "bad", schema: sampleSchema(), sources: [], chat: [] }),
      schema: { tables: [{ id: "x" }], relationships: [] },
    };
    const result = parseProjectFile(JSON.stringify(file));
    expect(result).toEqual({ ok: false, error: "Project file has an invalid schema." });
  });

  it("rejects an invalid source", () => {
    const file = {
      ...toProjectFile({ name: "bad", schema: sampleSchema(), sources: [], chat: [] }),
      sources: [{ id: "s1", name: "x" }],
    };
    const result = parseProjectFile(JSON.stringify(file));
    expect(result).toEqual({ ok: false, error: "Project file has an invalid source." });
  });

  it("falls back to a default name when none is provided", () => {
    const file = { ...toProjectFile({ name: "", schema: sampleSchema(), sources: [], chat: [] }) };
    const result = parseProjectFile(JSON.stringify(file));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.file.name).toBe("Imported project");
    }
  });
});

/* PR-0: the wide join-discovery sets are in-memory only — a multi-megabyte blow-up per project
 * if they ever reach disk, and the save path structuredClones with no zod pass, so both write
 * paths must strip them explicitly. */
describe("joinValues stripping", () => {
  function wideSource(): Source {
    return {
      id: "s-wide",
      name: "big.csv",
      kind: "csv",
      fields: [
        {
          name: "id",
          type: "int",
          samples: ["1", "2"],
          distinctValues: ["1", "2"],
          joinValues: Array.from({ length: 5000 }, (_, i) => String(i)),
        },
      ],
      rowCount: 5000,
    };
  }

  it("IndexedDB save path persists NO joinValues", async () => {
    const kv = new MemoryKeyValueStore();
    await saveProjectRecord(kv, record("wide", { sources: [wideSource()] }));

    const loaded = await loadProjectRecord(kv, "wide");
    expect(loaded?.sources[0]?.fields[0]?.joinValues).toBeUndefined();
    // The capped digests survive.
    expect(loaded?.sources[0]?.fields[0]?.distinctValues).toEqual(["1", "2"]);
  });

  it("saving does not strip the live in-memory sources (autosave fires mid-session)", async () => {
    const kv = new MemoryKeyValueStore();
    const live = record("wide", { sources: [wideSource()] });
    await saveProjectRecord(kv, live);

    expect(live.sources[0]?.fields[0]?.joinValues).toHaveLength(5000);
  });

  it("file-export path strips joinValues alongside sampleRows", () => {
    const file = toProjectFile({
      name: "p",
      schema: sampleSchema(),
      sources: [{ ...wideSource(), sampleRows: [["1"]] }],
      chat: [],
    });

    expect(file.sources[0]?.fields[0]?.joinValues).toBeUndefined();
    expect(file.sources[0]?.sampleRows).toBeUndefined();
    expect(file.sources[0]?.fields[0]?.distinctValues).toEqual(["1", "2"]);
  });
});
