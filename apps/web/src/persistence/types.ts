import type { Schema, Source } from "@schema-studio/core";

import type { ChatMessage } from "../copilot/messages.js";

/** Lightweight project descriptor used for listing/switching without loading the full body. */
export type ProjectMeta = {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
};

/** A full local project: its metadata plus the working set (schema, parsed sources, chat). */
export type ProjectRecord = ProjectMeta & {
  schema: Schema;
  sources: Source[];
  chat: ChatMessage[];
};

/**
 * Metadata plus the few derived display fields the Home/Projects grid needs (file chips, table
 * count, relationship count). Derived from the full record at list time — cheap because listing
 * already reads each record — so the grid never loads project bodies itself.
 */
export type ProjectSummary = ProjectMeta & {
  /** Source file names, in source order, for the card's file chips. */
  fileNames: string[];
  tableCount: number;
  /** Applied relationships (joins) in the schema — drives the card's status badge. */
  relationshipCount: number;
  /**
   * Total data rows across the project's source files. Present only when EVERY source
   * carries a known per-file count — a project containing sources parsed before `rowCount`
   * capture has no honest total, so the card omits the segment rather than undercounting.
   */
  rowCount?: number;
};

/**
 * Minimal async key/value contract the project layer depends on. The browser uses an
 * IndexedDB-backed implementation; tests use an in-memory one. Keeping persistence behind
 * this interface lets the project logic be unit-tested without a browser.
 */
export interface KeyValueStore {
  get<T>(key: string): Promise<T | undefined>;
  set<T>(key: string, value: T): Promise<void>;
  remove(key: string): Promise<void>;
  keys(): Promise<string[]>;
}

/** Marker + version for the import/export file format. */
export const PROJECT_FILE_KIND = "schema-studio/project";
// v2 adds `chat`. v1 files (no chat) still import — chat defaults to [].
export const PROJECT_FILE_VERSION = 2;

/** On-disk JSON shape for a project exported from / imported into the app. */
export type ProjectFile = {
  kind: typeof PROJECT_FILE_KIND;
  version: number;
  name: string;
  schema: Schema;
  sources: Source[];
  chat: ChatMessage[];
};
