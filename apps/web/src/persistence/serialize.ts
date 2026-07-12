import type { Schema, Source } from "@grafture/core";
import { SchemaSchema, SourceSchema } from "@grafture/core";

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
    // composite-key evidence until its sources are re-uploaded. The wide `joinValues`
    // sets are stripped too (up to MAX_JOIN_VALUES strings per column) — join detection
    // in an imported project degrades to the capped window until files are re-uploaded.
    sources: project.sources.map((source) => {
      const exported = { ...source };
      delete exported.sampleRows;
      return {
        ...exported,
        fields: exported.fields.map((field) => {
          if (field.joinValues === undefined) {
            return field;
          }
          const copy = { ...field };
          delete copy.joinValues;
          return copy;
        }),
      };
    }),
    chat: project.chat,
  };
}

export function serializeProjectFile(project: ExportableProject): string {
  return JSON.stringify(toProjectFile(project), null, 2);
}

export type ParseProjectResult = { ok: true; file: ProjectFile } | { ok: false; error: string };

export type ValidateRecordResult = { ok: true } | { ok: false; error: string };

/** Which part of a project's contents failed validation — mapped to surface-specific copy. */
type ContentsFailure = "schema" | "sources" | "source" | "chat" | "chat_message";

type ParseContentsResult =
  | { ok: true; schema: Schema; sources: Source[]; chat: ChatMessage[] }
  | { ok: false; invalid: ContentsFailure };

/**
 * The single validation core for a project's heavy contents. Both untrusted surfaces — file
 * import (`parseProjectFile`) and IndexedDB records read back at activation
 * (`validateProjectRecord`) — run through this one function, so the two paths cannot drift
 * apart in what they accept. Missing chat is treated as an empty conversation (v1 files);
 * present-but-malformed chat is rejected rather than silently dropped.
 */
function parseProjectContents(
  rawSchema: unknown,
  rawSources: unknown,
  rawChat: unknown,
): ParseContentsResult {
  const schemaResult = SchemaSchema.safeParse(rawSchema);
  if (!schemaResult.success) {
    return { ok: false, invalid: "schema" };
  }

  if (!Array.isArray(rawSources)) {
    return { ok: false, invalid: "sources" };
  }
  const sources: Source[] = [];
  for (const raw of rawSources) {
    const sourceResult = SourceSchema.safeParse(raw);
    if (!sourceResult.success) {
      return { ok: false, invalid: "source" };
    }
    sources.push(sourceResult.data);
  }

  const chat: ChatMessage[] = [];
  if (rawChat !== undefined) {
    if (!Array.isArray(rawChat)) {
      return { ok: false, invalid: "chat" };
    }
    for (const raw of rawChat) {
      const chatResult = ChatMessageSchema.safeParse(raw);
      if (!chatResult.success) {
        return { ok: false, invalid: "chat_message" };
      }
      chat.push(chatResult.data);
    }
  }

  return { ok: true, schema: schemaResult.data, sources, chat };
}

const RECORD_ERRORS: Record<ContentsFailure, string> = {
  schema: "its stored schema is invalid",
  sources: "its stored sources are invalid",
  source: "one of its stored sources is invalid",
  chat: "its stored chat history is invalid",
  chat_message: "its stored chat history is invalid",
};

/**
 * Validate a persisted record's contents before they replace the live store. Records read back
 * from IndexedDB bypass `parseProjectFile` (that guards the file-import path only), so project
 * activation re-checks schema, sources, and chat here — a corrupted record is rejected with a
 * reason, never loaded partially.
 */
export function validateProjectRecord(
  record: Pick<ProjectRecord, "schema" | "sources" | "chat">,
): ValidateRecordResult {
  const contents = parseProjectContents(record.schema, record.sources, record.chat);
  return contents.ok ? { ok: true } : { ok: false, error: RECORD_ERRORS[contents.invalid] };
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
    return { ok: false, error: "Not a Grafture project file." };
  }

  const contents = parseProjectContents(obj["schema"], obj["sources"], obj["chat"]);
  if (!contents.ok) {
    return { ok: false, error: FILE_ERRORS[contents.invalid] };
  }

  const rawName = obj["name"];
  const name =
    typeof rawName === "string" && rawName.trim().length > 0 ? rawName : "Imported project";
  const rawVersion = obj["version"];
  const version = typeof rawVersion === "number" ? rawVersion : PROJECT_FILE_VERSION;

  return {
    ok: true,
    file: {
      kind: PROJECT_FILE_KIND,
      version,
      name,
      schema: contents.schema,
      sources: contents.sources,
      chat: contents.chat,
    },
  };
}

const FILE_ERRORS: Record<ContentsFailure, string> = {
  schema: "Project file has an invalid schema.",
  sources: "Project file has invalid sources.",
  source: "Project file has an invalid source.",
  chat: "Project file has invalid chat history.",
  chat_message: "Project file has an invalid chat message.",
};
