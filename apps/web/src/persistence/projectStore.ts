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
  return {
    ...toMeta(record),
    fileNames: record.sources.map((source) => source.name),
    tableCount: record.schema.tables.length,
    relationshipCount: record.schema.relationships.length,
    rowCount: record.sources.reduce((total, source) => total + (source.rowCount ?? 0), 0),
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

export async function saveProjectRecord(kv: KeyValueStore, record: ProjectRecord): Promise<void> {
  await kv.set(projectKey(record.id), record);
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
