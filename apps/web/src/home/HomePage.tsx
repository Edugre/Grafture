import { useEffect, useMemo, useRef, useState } from "react";

import { useProjectsContext } from "../persistence/index.js";
import type { ProjectSummary } from "../persistence/index.js";
import {
  DatabaseIcon,
  GearIcon,
  KebabIcon,
  PencilIcon,
  PlusIcon,
  SearchIcon,
  TrashIcon,
  UserIcon,
} from "../ui/icons.js";
import {
  buildInitialSchemaPrompt,
  useAutoDraftPreference,
  type CopilotKickoff,
} from "../copilot/index.js";
import { ConfirmDialog } from "../ui/ConfirmDialog.js";
import { NewProjectModal, type DeriveInput } from "./NewProjectModal.js";
import { formatRelativeTime } from "./relativeTime.js";
import "./HomePage.css";

type FilterMode = "recent" | "all";

/** How many file chips to show before collapsing the rest into a "+N" chip. */
const MAX_CHIPS = 2;

/**
 * Home / Projects — the app's landing screen (handoff: design_handoff_home). Lists the user's
 * local projects as a searchable/filterable grid, with a dashed tile to derive a new one from
 * raw files. Project data comes from the shared projects context; selecting or creating a project
 * routes into the editor via `onEnterEditor`.
 *
 * "New project" / the derive tile open the New Project modal (handoff:
 * design_handoff_new_project_modal); each card has a kebab menu to rename (inline) or delete.
 *
 * Cards render only truthful, already-persisted metadata: file-name chips, table count, file
 * count, relative edited time, and a badge from the applied relationship count.
 */
export function HomePage({
  onOpenSettings,
  onEnterEditor,
}: {
  onOpenSettings: () => void;
  /** Enter the editor; `kickoff` seeds the Copilot (used by the New Project modal). */
  onEnterEditor: (kickoff?: CopilotKickoff) => void;
}) {
  const { summaries, ready, createProject, openProject, renameProject, deleteProject } =
    useProjectsContext();
  const { enabled: autoDraft } = useAutoDraftPreference();
  const [query, setQuery] = useState("");
  const [filterMode, setFilterMode] = useState<FilterMode>("recent");
  const [modalOpen, setModalOpen] = useState(false);
  const [menuId, setMenuId] = useState<string | null>(null);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState<string | null>(null);

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    const matched = needle
      ? summaries.filter(
          (project) =>
            project.name.toLowerCase().includes(needle) ||
            project.fileNames.some((file) => file.toLowerCase().includes(needle)),
        )
      : summaries;
    // "Recent" keeps the store's updated-desc order; "All" switches to alphabetical.
    return filterMode === "all"
      ? [...matched].sort((a, b) => a.name.localeCompare(b.name))
      : matched;
  }, [summaries, query, filterMode]);

  const open = (id: string) => {
    openProject(id);
    onEnterEditor();
  };

  const derive = (input: DeriveInput) => {
    setModalOpen(false);
    // When auto-draft is on, send a framed prompt and let the Copilot draft a ghost schema.
    // Otherwise preserve today's behavior: seed the raw description into the input to send manually.
    const kickoff: CopilotKickoff | undefined = autoDraft
      ? { message: buildInitialSchemaPrompt(input), autoDraft: true }
      : input.description
        ? { message: input.description, autoDraft: false }
        : undefined;
    // Await the new project so its sources are in the store before the editor (and any auto-draft)
    // reads them, then enter.
    void createProject({ name: input.name, sources: input.sources }).then(() =>
      onEnterEditor(kickoff),
    );
  };

  const startRename = (id: string) => {
    setMenuId(null);
    setEditingId(id);
  };

  const commitRename = (id: string, name: string) => {
    setEditingId(null);
    renameProject(id, name);
  };

  const confirmDeleteProject = summaries.find((project) => project.id === confirmDeleteId);

  return (
    <div className="home">
      <header className="home-topbar">
        <div className="home-topbar__brand">
          <span className="home-topbar__logo" aria-hidden>
            <DatabaseIcon size={14} />
          </span>
          <span className="home-topbar__wordmark">Schema Studio</span>
        </div>
        <div className="home-topbar__right">
          <button
            type="button"
            className="home-topbar__icon-btn"
            onClick={onOpenSettings}
            aria-label="Settings"
            title="Settings"
          >
            <GearIcon size={16} />
          </button>
          <span className="home-topbar__avatar" aria-hidden>
            <UserIcon size={16} />
          </span>
        </div>
      </header>

      <div className="home-content">
        <div className="home-header">
          <div>
            <h1 className="home-header__title">Projects</h1>
            <p className="home-header__subtitle">
              Pick a schema to keep working, or derive a new one from raw files.
            </p>
          </div>
          <button
            type="button"
            className="home-newbtn"
            onClick={() => setModalOpen(true)}
            disabled={!ready}
          >
            <PlusIcon size={16} />
            New project
          </button>
        </div>

        <div className="home-filters">
          <div className="home-search">
            <SearchIcon size={16} className="home-search__icon" />
            <input
              className="home-search__input"
              type="search"
              placeholder="Search projects…"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              aria-label="Search projects"
            />
          </div>
          <div className="home-segmented" role="tablist" aria-label="Filter projects">
            {(["recent", "all"] as const).map((mode) => (
              <button
                key={mode}
                type="button"
                role="tab"
                aria-selected={filterMode === mode}
                className={`home-segmented__option${filterMode === mode ? " is-active" : ""}`}
                onClick={() => setFilterMode(mode)}
              >
                {mode === "recent" ? "Recent" : "All"}
              </button>
            ))}
          </div>
        </div>

        <div className="home-grid">
          {visible.map((project) => (
            <ProjectCard
              key={project.id}
              project={project}
              editing={editingId === project.id}
              menuOpen={menuId === project.id}
              onOpen={() => open(project.id)}
              onToggleMenu={() =>
                setMenuId((current) => (current === project.id ? null : project.id))
              }
              onCloseMenu={() => setMenuId(null)}
              onStartRename={() => startRename(project.id)}
              onCommitRename={(name) => commitRename(project.id, name)}
              onCancelRename={() => setEditingId(null)}
              onDelete={() => {
                setMenuId(null);
                setConfirmDeleteId(project.id);
              }}
            />
          ))}

          {ready && visible.length === 0 && query.trim() ? (
            <p className="home-empty">No projects match “{query}”.</p>
          ) : null}

          <button
            type="button"
            className="home-derive"
            onClick={() => setModalOpen(true)}
            disabled={!ready}
          >
            <span className="home-derive__icon" aria-hidden>
              <PlusIcon size={18} />
            </span>
            <span className="home-derive__title">Derive from files</span>
            <span className="home-derive__subtitle">Drop CSV, XLSX or JSON to start</span>
          </button>
        </div>
      </div>

      {modalOpen ? <NewProjectModal onClose={() => setModalOpen(false)} onDerive={derive} /> : null}

      {confirmDeleteProject ? (
        <ConfirmDialog
          title="Delete project?"
          message={
            <>
              <strong>{confirmDeleteProject.name}</strong> and its sources will be permanently
              removed from this browser. This can’t be undone.
            </>
          }
          confirmLabel="Delete"
          danger
          onConfirm={() => {
            deleteProject(confirmDeleteProject.id);
            setConfirmDeleteId(null);
          }}
          onCancel={() => setConfirmDeleteId(null)}
        />
      ) : null}
    </div>
  );
}

function ProjectCard({
  project,
  editing,
  menuOpen,
  onOpen,
  onToggleMenu,
  onCloseMenu,
  onStartRename,
  onCommitRename,
  onCancelRename,
  onDelete,
}: {
  project: ProjectSummary;
  editing: boolean;
  menuOpen: boolean;
  onOpen: () => void;
  onToggleMenu: () => void;
  onCloseMenu: () => void;
  onStartRename: () => void;
  onCommitRename: (name: string) => void;
  onCancelRename: () => void;
  onDelete: () => void;
}) {
  const chips = project.fileNames.slice(0, MAX_CHIPS);
  const overflow = project.fileNames.length - chips.length;
  const menuRef = useRef<HTMLDivElement>(null);

  // Dismiss the menu on an outside click or Esc while it's open.
  useEffect(() => {
    if (!menuOpen) {
      return;
    }
    const onDocClick = (event: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        onCloseMenu();
      }
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onCloseMenu();
      }
    };
    document.addEventListener("mousedown", onDocClick);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDocClick);
      document.removeEventListener("keydown", onKey);
    };
  }, [menuOpen, onCloseMenu]);

  const interactive = !editing && !menuOpen;

  return (
    <div
      className="home-card"
      role="button"
      tabIndex={0}
      onClick={() => interactive && onOpen()}
      onKeyDown={(event) => {
        if (interactive && (event.key === "Enter" || event.key === " ")) {
          event.preventDefault();
          onOpen();
        }
      }}
    >
      <div className="home-card__head">
        <span className="home-card__type" aria-hidden>
          <DatabaseIcon size={17} />
        </span>
        <div className="home-card__head-right">
          {project.relationshipCount > 0 ? (
            <span className="home-card__badge">
              <span className="home-card__badge-dot" aria-hidden />
              {project.relationshipCount} {project.relationshipCount === 1 ? "join" : "joins"}
            </span>
          ) : null}
          <div className="home-card__menu" ref={menuRef}>
            <button
              type="button"
              className="home-card__kebab"
              aria-label="Project options"
              aria-haspopup="menu"
              aria-expanded={menuOpen}
              onClick={(event) => {
                event.stopPropagation();
                onToggleMenu();
              }}
            >
              <KebabIcon size={16} />
            </button>
            {menuOpen ? (
              <div className="home-menu" role="menu">
                <button
                  type="button"
                  role="menuitem"
                  className="home-menu__item"
                  onClick={(event) => {
                    event.stopPropagation();
                    onStartRename();
                  }}
                >
                  <PencilIcon size={14} />
                  Edit name
                </button>
                <button
                  type="button"
                  role="menuitem"
                  className="home-menu__item home-menu__item--danger"
                  onClick={(event) => {
                    event.stopPropagation();
                    onDelete();
                  }}
                >
                  <TrashIcon size={14} />
                  Delete
                </button>
              </div>
            ) : null}
          </div>
        </div>
      </div>

      <div>
        {editing ? (
          <input
            className="home-card__name-edit"
            defaultValue={project.name}
            autoFocus
            onClick={(event) => event.stopPropagation()}
            onKeyDown={(event) => {
              event.stopPropagation();
              if (event.key === "Enter") {
                onCommitRename((event.target as HTMLInputElement).value);
              } else if (event.key === "Escape") {
                onCancelRename();
              }
            }}
            onBlur={(event) => onCommitRename(event.target.value)}
          />
        ) : (
          <div className="home-card__name">{project.name}</div>
        )}
        <div className="home-card__chips">
          {chips.map((file) => (
            <span key={file} className="home-card__chip">
              {file}
            </span>
          ))}
          {overflow > 0 ? <span className="home-card__chip">+{overflow}</span> : null}
          {project.fileNames.length === 0 ? (
            <span className="home-card__chip home-card__chip--empty">no files yet</span>
          ) : null}
        </div>
      </div>

      <div className="home-card__footer">
        <span>
          {project.tableCount} {project.tableCount === 1 ? "table" : "tables"}
        </span>
        <span className="home-card__dot" aria-hidden>
          ·
        </span>
        <span>
          {project.fileNames.length} {project.fileNames.length === 1 ? "file" : "files"}
        </span>
        {project.rowCount > 0 ? (
          <>
            <span className="home-card__dot" aria-hidden>
              ·
            </span>
            <span>
              {project.rowCount.toLocaleString()} {project.rowCount === 1 ? "row" : "rows"}
            </span>
          </>
        ) : null}
        <span className="home-card__dot" aria-hidden>
          ·
        </span>
        <span>edited {formatRelativeTime(project.updatedAt)}</span>
      </div>
    </div>
  );
}
