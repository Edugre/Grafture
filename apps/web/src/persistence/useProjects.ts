import type { Schema, Source } from "@schema-studio/core";
import { emptySchema } from "@schema-studio/core";
import { useCallback, useEffect, useRef, useState } from "react";

import type { ChatMessage } from "../copilot/messages.js";
import { useSchemaStore } from "../store/index.js";
import { IndexedDbKeyValueStore } from "./kv.js";
import {
  deleteProjectRecord,
  getActiveProjectId,
  listProjectSummaries,
  loadProjectRecord,
  saveProjectRecord,
  setActiveProjectId,
} from "./projectStore.js";
import { parseProjectFile, serializeProjectFile, validateProjectRecord } from "./serialize.js";
import type { KeyValueStore, ProjectMeta, ProjectRecord, ProjectSummary } from "./types.js";

const AUTOSAVE_DELAY = 500;
const DEFAULT_NAME = "Untitled project";

const makeId = (): string => crypto.randomUUID();

function newRecord(
  name: string,
  schema: Schema,
  sources: Source[],
  chat: ChatMessage[],
): ProjectRecord {
  const now = Date.now();
  return { id: makeId(), name, createdAt: now, updatedAt: now, schema, sources, chat };
}

export type UseProjects = {
  projects: ProjectMeta[];
  /** Same list enriched with the Home-grid display fields (file chips, counts). */
  summaries: ProjectSummary[];
  activeId: string | undefined;
  ready: boolean;
  error: string | undefined;
  dismissError: () => void;
  newProject: () => void;
  /**
   * Create a project from explicit contents (e.g. the New Project modal: a name + parsed
   * source files) and make it active. Falls back to the default name when none is given. Resolves
   * once the new project is active in the store, so callers can rely on the canvas being populated.
   */
  createProject: (opts?: {
    name?: string;
    sources?: Source[];
    chat?: ChatMessage[];
  }) => Promise<void>;
  openProject: (id: string) => void;
  deleteProject: (id: string) => void;
  renameProject: (id: string, name: string) => void;
  exportProject: () => void;
  importProject: (file: File) => void;
};

/**
 * Owns local-project lifecycle: bootstrap, debounced autosave of the live store, and the
 * new/open/delete/rename/import/export commands. Switching projects routes through the store's
 * `loadProject` command so undo/redo stays correct. The key/value backend is injectable for tests.
 */
export function useProjects(
  createKv: () => KeyValueStore = () => new IndexedDbKeyValueStore(),
): UseProjects {
  const kvRef = useRef<KeyValueStore | null>(null);
  if (kvRef.current === null) {
    kvRef.current = createKv();
  }
  const kv = kvRef.current;

  const [projects, setProjects] = useState<ProjectMeta[]>([]);
  const [summaries, setSummaries] = useState<ProjectSummary[]>([]);
  const [activeId, setActiveIdState] = useState<string | undefined>(undefined);
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | undefined>(undefined);

  const activeIdRef = useRef<string | undefined>(undefined);
  activeIdRef.current = activeId;
  const initStartedRef = useRef(false);

  const fail = useCallback((reason: unknown) => {
    setError(reason instanceof Error ? reason.message : String(reason));
  }, []);

  const refreshList = useCallback(async () => {
    // One read of every record yields both lists (summaries are a superset of meta).
    const list = await listProjectSummaries(kv);
    setSummaries(list);
    setProjects(list);
  }, [kv]);

  // Imperative flush of any pending autosave. Set by the autosave effect; called before a
  // project switch so the outgoing project's in-flight edits are written before the store is
  // replaced. No-op until the effect installs the real implementation.
  const flushRef = useRef<() => Promise<void>>(async () => {});

  // Write the active project record from explicit values (id + live store state). Shared by
  // the debounced autosave and the pre-switch flush.
  const writeActive = useCallback(
    async (id: string, schema: Schema, sources: Source[], chat: ChatMessage[]) => {
      const previous = await loadProjectRecord(kv, id);
      // Every live project record is created explicitly (create/import/bootstrap) before it can
      // become active, so a missing record means the project was deleted while this save was
      // pending (e.g. the debounce timer fired mid-delete). Writing would resurrect it.
      if (!previous) {
        return;
      }
      await saveProjectRecord(kv, {
        id,
        name: previous.name,
        createdAt: previous.createdAt,
        updatedAt: Date.now(),
        schema,
        sources,
        chat,
      });
      await refreshList();
    },
    [kv, refreshList],
  );

  // Validate before the wholesale store swap: records read from IndexedDB skip the
  // import-path checks, and `loadProject` installs them as-is. Returns whether the
  // project was actually activated.
  const activate = useCallback((record: ProjectRecord): boolean => {
    const valid = validateProjectRecord(record);
    if (!valid.ok) {
      setError(`Can't open "${record.name}": ${valid.error}.`);
      return false;
    }
    useSchemaStore.getState().loadProject(record.schema, record.sources, record.chat);
    setActiveIdState(record.id);
    return true;
  }, []);

  // Bootstrap: restore the last active project, or create one from whatever is on the canvas.
  useEffect(() => {
    if (initStartedRef.current) {
      return;
    }
    initStartedRef.current = true;

    void (async () => {
      const activeIdFromDb = await getActiveProjectId(kv);
      const record = activeIdFromDb ? await loadProjectRecord(kv, activeIdFromDb) : undefined;

      // No auto-created default project: when there's nothing to restore, the Home screen shows
      // just the "derive" card. The editor is only reached by opening or creating a project, both
      // of which set an active project, so the store never needs a placeholder here.
      if (record) {
        activate(record);
      }
      await refreshList();
      setReady(true);
    })().catch(fail);
  }, [kv, activate, refreshList, fail]);

  // Debounced autosave of the live store into the active project.
  useEffect(() => {
    if (!ready) {
      return;
    }

    let timer: ReturnType<typeof setTimeout> | undefined;

    // Write the current store state to the current active project, cancelling any pending
    // debounce. Reads id + state at call time so it's correct whether fired by the timer or
    // invoked synchronously as a pre-switch flush (before `loadProject` replaces the store).
    const saveNow = async (): Promise<void> => {
      if (timer) {
        clearTimeout(timer);
        timer = undefined;
      }
      const id = activeIdRef.current;
      if (!id) {
        return;
      }
      const state = useSchemaStore.getState();
      await writeActive(id, state.schema, state.sources, state.chat);
    };

    flushRef.current = saveNow;

    const unsubscribe = useSchemaStore.subscribe((state, prev) => {
      if (
        state.schema === prev.schema &&
        state.sources === prev.sources &&
        state.chat === prev.chat
      ) {
        return;
      }
      if (timer) {
        clearTimeout(timer);
      }
      timer = setTimeout(() => void saveNow().catch(fail), AUTOSAVE_DELAY);
    });

    return () => {
      if (timer) {
        clearTimeout(timer);
      }
      flushRef.current = async () => {};
      unsubscribe();
    };
  }, [ready, writeActive, fail]);

  const createProject = useCallback(
    async (opts?: { name?: string; sources?: Source[]; chat?: ChatMessage[] }) => {
      try {
        await flushRef.current();
        const name = opts?.name?.trim() || DEFAULT_NAME;
        const record = newRecord(name, emptySchema(), opts?.sources ?? [], opts?.chat ?? []);
        await saveProjectRecord(kv, record);
        await setActiveProjectId(kv, record.id);
        activate(record);
        await refreshList();
      } catch (reason) {
        fail(reason);
      }
    },
    [kv, activate, refreshList, fail],
  );

  const newProject = useCallback(() => void createProject(), [createProject]);

  const openProject = useCallback(
    (id: string) => {
      if (id === activeIdRef.current) {
        return;
      }
      void (async () => {
        await flushRef.current();
        const record = await loadProjectRecord(kv, id);
        if (!record) {
          setError("Project not found.");
          return;
        }
        if (!activate(record)) {
          return;
        }
        await setActiveProjectId(kv, id);
        await refreshList();
      })().catch(fail);
    },
    [kv, activate, refreshList, fail],
  );

  const deleteProject = useCallback(
    (id: string) => {
      void (async () => {
        await deleteProjectRecord(kv, id);

        // Deleting the active project (always from Home) clears the active slot rather than
        // minting a replacement — the Home grid simply drops the card.
        if (id === activeIdRef.current) {
          await setActiveProjectId(kv, undefined);
          useSchemaStore.getState().loadProject(emptySchema(), []);
          setActiveIdState(undefined);
        }

        await refreshList();
      })().catch(fail);
    },
    [kv, activate, refreshList, fail],
  );

  const renameProject = useCallback(
    (id: string, name: string) => {
      const trimmed = name.trim();
      if (!trimmed) {
        return;
      }
      void (async () => {
        const record = await loadProjectRecord(kv, id);
        if (!record) {
          return;
        }
        record.name = trimmed;
        record.updatedAt = Date.now();
        await saveProjectRecord(kv, record);
        await refreshList();
      })().catch(fail);
    },
    [kv, refreshList, fail],
  );

  const exportProject = useCallback(() => {
    const meta = projects.find((project) => project.id === activeIdRef.current);
    const state = useSchemaStore.getState();
    const name = meta?.name ?? DEFAULT_NAME;
    const json = serializeProjectFile({
      name,
      schema: state.schema,
      sources: state.sources,
      chat: state.chat,
    });

    const blob = new Blob([json], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `${name.replace(/[^\w.-]+/g, "_") || "project"}.schemastudio.json`;
    anchor.click();
    URL.revokeObjectURL(url);
  }, [projects]);

  const importProject = useCallback(
    (file: File) => {
      void (async () => {
        const text = await file.text();
        const result = parseProjectFile(text);
        if (!result.ok) {
          setError(result.error);
          return;
        }
        await flushRef.current();
        const record = newRecord(
          result.file.name,
          result.file.schema,
          result.file.sources,
          result.file.chat,
        );
        await saveProjectRecord(kv, record);
        await setActiveProjectId(kv, record.id);
        activate(record);
        await refreshList();
        setError(undefined);
      })().catch(fail);
    },
    [kv, activate, refreshList, fail],
  );

  const dismissError = useCallback(() => setError(undefined), []);

  return {
    projects,
    summaries,
    activeId,
    ready,
    error,
    dismissError,
    newProject,
    createProject,
    openProject,
    deleteProject,
    renameProject,
    exportProject,
    importProject,
  };
}
