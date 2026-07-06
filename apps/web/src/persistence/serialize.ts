import type { Source } from "@schema-studio/core";
import { SchemaSchema, SourceSchema } from "@schema-studio/core";

import { type ChatMessage, ChatMessageSchema } from "../copilot/messages.js";
import {
  PROJECT_FILE_KIND,
  PROJECT_FILE_VERSION,
  type ProjectFile,
  type ProjectRecord,
} from "./types.js";

type ExportableProject = Pick<ProjectRecord, "name" | "schema" | "sources" | "chat">;

export function toProjectFile(project: ExportableProject): ProjectFile {
  return {
    kind: PROJECT_FILE_KIND,
    version: PROJECT_FILE_VERSION,
    name: project.name,
    schema: project.schema,
    // Strip sampleRows from the shareable export: aligned raw row tuples restore the
    // cross-column correlation that the per-column digests (samples/distinctValues)
    // deliberately don't carry — a re-identification risk in a file meant to be shared.
    // Local persistence (IndexedDB) keeps them; an imported project merely lacks
    // composite-key evidence until its sources are re-uploaded.
    sources: project.sources.map((source) => {
      const exported = { ...source };
      delete exported.sampleRows;
      return exported;
    }),
    chat: project.chat,
  };
}

export function serializeProjectFile(project: ExportableProject): string {
  return JSON.stringify(toProjectFile(project), null, 2);
}

export type ParseProjectResult = { ok: true; file: ProjectFile } | { ok: false; error: string };

export type ValidateRecordResult = { ok: true } | { ok: false; error: string };

/**
 * Validate a persisted record's contents before they replace the live store. Records read back
 * from IndexedDB bypass `parseProjectFile` (that guards the file-import path only), so project
 * activation re-checks the schema and sources here — a corrupted record is rejected with a
 * reason, never loaded partially.
 */
export function validateProjectRecord(
  record: Pick<ProjectRecord, "schema" | "sources">,
): ValidateRecordResult {
  if (!SchemaSchema.safeParse(record.schema).success) {
    return { ok: false, error: "its stored schema is invalid" };
  }
  for (const source of record.sources) {
    if (!SourceSchema.safeParse(source).success) {
      return { ok: false, error: "one of its stored sources is invalid" };
    }
  }
  return { ok: true };
}

/**
 * Validate untrusted JSON as a project file. The schema and every source are checked against
 * core's zod models — an invalid import is rejected with a reason, never partially loaded.
 */
export function parseProjectFile(text: string): ParseProjectResult {
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return { ok: false, error: "File is not valid JSON." };
  }

  if (typeof json !== "object" || json === null) {
    return { ok: false, error: "Project file must be a JSON object." };
  }

  const obj = json as Record<string, unknown>;
  if (obj["kind"] !== PROJECT_FILE_KIND) {
    return { ok: false, error: "Not a Schema Studio project file." };
  }

  const schemaResult = SchemaSchema.safeParse(obj["schema"]);
  if (!schemaResult.success) {
    return { ok: false, error: "Project file has an invalid schema." };
  }

  const rawSources = obj["sources"];
  if (!Array.isArray(rawSources)) {
    return { ok: false, error: "Project file has invalid sources." };
  }

  const sources: Source[] = [];
  for (const raw of rawSources) {
    const sourceResult = SourceSchema.safeParse(raw);
    if (!sourceResult.success) {
      return { ok: false, error: "Project file has an invalid source." };
    }
    sources.push(sourceResult.data);
  }

  // Chat was added in v2. v1 files omit it; treat a missing field as an empty conversation,
  // but reject a present-but-malformed one rather than silently dropping messages.
  const chat: ChatMessage[] = [];
  const rawChat = obj["chat"];
  if (rawChat !== undefined) {
    if (!Array.isArray(rawChat)) {
      return { ok: false, error: "Project file has invalid chat history." };
    }
    for (const raw of rawChat) {
      const chatResult = ChatMessageSchema.safeParse(raw);
      if (!chatResult.success) {
        return { ok: false, error: "Project file has an invalid chat message." };
      }
      chat.push(chatResult.data);
    }
  }

  const rawName = obj["name"];
  const name =
    typeof rawName === "string" && rawName.trim().length > 0 ? rawName : "Imported project";
  const rawVersion = obj["version"];
  const version = typeof rawVersion === "number" ? rawVersion : PROJECT_FILE_VERSION;

  return {
    ok: true,
    file: { kind: PROJECT_FILE_KIND, version, name, schema: schemaResult.data, sources, chat },
  };
}
