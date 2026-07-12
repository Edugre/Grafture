import type { Source } from "@grafture/core";

import type { KeyValueStore, ProjectMeta, ProjectRecord, ProjectSummary } from "./types.js";

const PROJECT_PREFIX = "project:";
const ACTIVE_KEY = "meta:activeId";

const projectKey = (id: string): string => `${PROJECT_PREFIX}${id}`;

export function toMeta(record: ProjectRecord): ProjectMeta {
  return {
    id: record.id,
    name: record.name,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

export function toSummary(record: ProjectRecord): ProjectSummary {
  // A total is only honest when every source has a known count; summing legacy (pre-capture)
  // sources as 0 would display a confident undercount.
  const knownCounts = record.sources
    .map((source) => source.rowCount)
    .filter((count): count is number => count !== undefined);

  return {
    ...toMeta(record),
    fileNames: record.sources.map((source) => source.name),
    tableCount: record.schema.tables.length,
    relationshipCount: record.schema.relationships.length,
    ...(knownCounts.length === record.sources.length
      ? { rowCount: knownCounts.reduce((total, count) => total + count, 0) }
      : {}),
  };
}

/** Read every stored record once, newest first. Shared by the meta/summary listings below. */
async function readAllRecords(kv: KeyValueStore): Promise<ProjectRecord[]> {
  const keys = (await kv.keys()).filter((key) => key.startsWith(PROJECT_PREFIX));
  const records = await Promise.all(keys.map((key) => kv.get<ProjectRecord>(key)));
  return records
    .filter((record): record is ProjectRecord => record !== undefined)
    .sort((a, b) => b.updatedAt - a.updatedAt);
}

/** All projects' metadata, most recently updated first. */
export async function listProjects(kv: KeyValueStore): Promise<ProjectMeta[]> {
  return (await readAllRecords(kv)).map(toMeta);
}

/** All projects' summaries (metadata + Home-grid display fields), most recently updated first. */
export async function listProjectSummaries(kv: KeyValueStore): Promise<ProjectSummary[]> {
  return (await readAllRecords(kv)).map(toSummary);
}

export async function loadProjectRecord(
  kv: KeyValueStore,
  id: string,
): Promise<ProjectRecord | undefined> {
  return kv.get<ProjectRecord>(projectKey(id));
}

/**
 * Strip the wide join-discovery sets before a source is written to disk. `joinValues` can hold
 * up to MAX_JOIN_VALUES strings per column (a multi-megabyte blow-up per project), and the save
 * path `structuredClone`s the raw record with no zod pass — so the strip must happen explicitly
 * here, on a CLONE: the caller hands us the live in-memory sources, and a debounced autosave
 * fires mid-session, so a bare `delete` would strip the wide sets from the running store.
 */
function stripJoinValues(sources: Source[]): Source[] {
  return sources.map((source) => ({
    ...source,
    fields: source.fields.map((field) => {
      if (field.joinValues === undefined) {
        return field;
      }
      const copy = { ...field };
      delete copy.joinValues;
      return copy;
    }),
  }));
}

export async function saveProjectRecord(kv: KeyValueStore, record: ProjectRecord): Promise<void> {
  await kv.set(projectKey(record.id), { ...record, sources: stripJoinValues(record.sources) });
}

export async function deleteProjectRecord(kv: KeyValueStore, id: string): Promise<void> {
  await kv.remove(projectKey(id));
}

export async function getActiveProjectId(kv: KeyValueStore): Promise<string | undefined> {
  return kv.get<string>(ACTIVE_KEY);
}

export async function setActiveProjectId(kv: KeyValueStore, id: string | undefined): Promise<void> {
  if (id === undefined) {
    await kv.remove(ACTIVE_KEY);
    return;
  }
  await kv.set(ACTIVE_KEY, id);
}
