import type { Source } from "@grafture/core";
import { ParseError } from "@grafture/core";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

import { nextPaint } from "../sources/nextPaint.js";
import { readAndParseFile } from "../sources/readAndParse.js";
import { DatabaseIcon, FileIcon, FilePlusIcon, PlusIcon, UploadIcon, XIcon } from "../ui/icons.js";
import { CreateProgress, type CreateStep } from "./CreateProgress.js";
import "./NewProjectModal.css";

/**
 * A file the user handed us, tracked from the moment it lands rather than only once it parses.
 * The row is on screen while it's still `queued`/`parsing`, so the wait has a shape instead of a
 * single anonymous "Parsing files locally…" line. Only `ready` entries carry sources.
 */
type FileEntry = {
  /** A local id until the file parses, then the first source's id. */
  id: string;
  name: string;
  /** Bytes of the original file, for the meta line. */
  size: number;
  state: "queued" | "parsing" | "ready" | "failed";
  /** Every source the file parsed into — a JSON file can unnest child sources after its parent. */
  sources: Source[];
  /** Set only when `state === "failed"`; shown on the row itself, not in a merged banner. */
  error?: string;
};

export type DeriveInput = { name: string; description: string; sources: Source[] };

const ACCEPT = ".csv,.xlsx,.json";

/**
 * How long creation may take before the card morphs into the progress view. Under this, the work
 * is done before a spinner would have been legible and flashing one is worse than showing nothing.
 */
const MORPH_AFTER_MS = 180;

/** Goal chips that seed the description — phrased as the content-aware things the engine reasons about. */
const SUGGESTION_CHIPS = [
  "Find joins between tables",
  "Flag type mismatches",
  "Deduplicate records",
];

let entrySeq = 0;

function prefersReducedMotion(): boolean {
  return window.matchMedia("(prefers-reduced-motion: reduce)").matches;
}

function formatSize(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${Math.round(bytes / 1024)} KB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? "" : "s"}`;
}

/** The row's sub-line. Every state gets a truthful one — none of them is a guess at progress. */
function metaLine(file: FileEntry): string {
  if (file.state === "queued") {
    return `Queued · ${formatSize(file.size)}`;
  }
  if (file.state === "parsing") {
    return `Reading columns · ${formatSize(file.size)}`;
  }
  if (file.state === "failed") {
    return file.error ?? "Couldn’t parse this file";
  }
  const columns = file.sources[0]?.fields.length ?? 0;
  const children = file.sources.length - 1;
  const childNote = children > 0 ? ` · ${plural(children, "nested table")}` : "";
  return `${plural(columns, "column")}${childNote} · ${formatSize(file.size)}`;
}

/**
 * New Project modal (handoff: design_handoff_new_project_modal). Drop/browse raw files, name the
 * project, and describe the data + goals, then create the project with the parsed sources and enter
 * the editor. Files are parsed locally (nothing is uploaded); the description is carried into the
 * Copilot as context. Files are optional — a project can be created empty and files added later.
 *
 * When the experimental "draft an initial schema with AI" preference is on (`autoDraft`), the copy
 * frames creation as deriving a schema; when off, it stays neutral and makes no schema-deriving
 * promises.
 *
 * The modal has two loading moments, both designed rather than implied:
 *  - **parse** — files are read one at a time so each row can show queued → parsing → ready/failed
 *    with its real column count. A file that fails fails on its own row; the rest still land.
 *  - **create** — the card morphs in place into `CreateProgress` once the save outlives
 *    {@link MORPH_AFTER_MS}. Same scrim, same card, no second dialog.
 */
export function NewProjectModal({
  onClose,
  onDerive,
  autoDraft,
}: {
  onClose: () => void;
  /** Resolves once the project is saved; rejects so the modal can show the failure and offer a retry. */
  onDerive: (input: DeriveInput) => Promise<void>;
  /** The experimental AI schema-drafting preference; gates the "derive schema" framing. */
  autoDraft: boolean;
}) {
  const [files, setFiles] = useState<FileEntry[]>([]);
  const [dragging, setDragging] = useState(false);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");

  const [stage, setStage] = useState<"form" | "creating">("form");
  const [steps, setSteps] = useState<CreateStep[]>([]);
  const [createError, setCreateError] = useState<string | undefined>(undefined);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  /** The card height captured just before a stage swap, so the morph has something to animate from. */
  const morphFromRef = useRef<number | null>(null);

  const readyFiles = files.filter((file) => file.state === "ready");
  const settling = files.filter((file) => file.state === "queued" || file.state === "parsing");
  const parsing = settling.length > 0;
  const creating = stage === "creating";
  const busy = parsing || (creating && createError === undefined);

  // Esc to close + lock background scroll while open. Esc is inert mid-save: there is nothing to
  // cancel once the write is in flight, and closing would strand a half-created project.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !(creating && createError === undefined)) {
        onClose();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      document.body.style.overflow = previousOverflow;
    };
  }, [onClose, creating, createError]);

  // Move focus into the dialog on open for keyboard users.
  useEffect(() => {
    cardRef.current?.focus();
  }, []);

  /**
   * Animate the card between the form's height and the progress body's height. The "from" height is
   * captured by the caller before the swap (by then the DOM already holds the new content), so all
   * this does is pin it back, force a reflow, and transition to the measured target.
   */
  useLayoutEffect(() => {
    const card = cardRef.current;
    const from = morphFromRef.current;
    morphFromRef.current = null;
    if (!card || from === null || prefersReducedMotion()) {
      return;
    }
    const to = card.offsetHeight;
    if (to === from) {
      return;
    }
    card.style.transition = "none";
    card.style.height = `${from}px`;
    void card.offsetHeight; // reflow, so the transition below has a start value
    card.style.transition = "height var(--dur-arrange) var(--ease-in-out)";
    card.style.height = `${to}px`;

    const release = () => {
      card.style.height = "";
      card.style.transition = "";
    };
    const settle = (event: TransitionEvent) => {
      if (event.propertyName === "height") {
        release();
      }
    };
    card.addEventListener("transitionend", settle);
    // transitionend is not guaranteed: a hidden tab never runs the transition at all, and an
    // interrupted one can drop the event. Without this the card would keep a pinned inline
    // height forever and stop sizing to its content.
    const failsafe = window.setTimeout(release, 600);

    return () => {
      card.removeEventListener("transitionend", settle);
      window.clearTimeout(failsafe);
      release();
    };
  }, [stage]);

  /** Swap the card body, capturing the outgoing height so the morph has a start point. */
  const swapStage = useCallback((next: "form" | "creating") => {
    morphFromRef.current = cardRef.current?.offsetHeight ?? null;
    setStage(next);
  }, []);

  const ingest = useCallback(async (incoming: FileList | File[]) => {
    const list = Array.from(incoming);
    if (list.length === 0) {
      return;
    }

    const batch: FileEntry[] = list.map((file) => ({
      id: `pending:${(entrySeq += 1)}`,
      name: file.name,
      size: file.size,
      state: "queued",
      sources: [],
    }));

    // De-dupe by name so re-dropping the same file replaces rather than stacks it.
    setFiles((current) => {
      const byName = new Map(current.map((entry) => [entry.name, entry]));
      for (const entry of batch) {
        byName.set(entry.name, entry);
      }
      return Array.from(byName.values());
    });

    const patch = (key: string, next: Partial<FileEntry>) => {
      setFiles((current) =>
        current.map((entry) => (entry.id === key ? { ...entry, ...next } : entry)),
      );
    };

    // Sequential on purpose: parsing is synchronous CPU work, so running it in parallel would
    // interleave into one long freeze with nothing to show. One at a time gives every row a real
    // parsing state and keeps the frame budget for painting it.
    for (const [index, file] of list.entries()) {
      const key = batch[index]?.id;
      if (key === undefined) {
        continue;
      }
      patch(key, { state: "parsing" });
      await nextPaint();
      try {
        const sources = await readAndParseFile(file);
        const id = sources[0]?.id;
        if (id === undefined) {
          throw new ParseError("No table found in this file", file.name);
        }
        patch(key, { id, state: "ready", sources });
      } catch (failure) {
        // The reason only — the row heading right above it already shows the file name, and
        // ParseError deliberately keeps the name out of `message` (see core's ParseError).
        const text =
          failure instanceof ParseError || failure instanceof Error
            ? failure.message
            : "Failed to parse file";
        patch(key, { state: "failed", error: text });
      }
    }
  }, []);

  const onDrop = (event: React.DragEvent) => {
    event.preventDefault();
    setDragging(false);
    void ingest(event.dataTransfer.files);
  };

  const onPick = (event: React.ChangeEvent<HTMLInputElement>) => {
    if (event.target.files) {
      void ingest(event.target.files);
    }
    event.target.value = ""; // allow re-selecting the same file
  };

  const removeFile = (id: string) => {
    setFiles((current) => current.filter((entry) => entry.id !== id));
  };

  const appendChip = (text: string) => {
    setDescription((current) => {
      const trimmed = current.trim();
      if (trimmed.length === 0) {
        return text;
      }
      if (trimmed.toLowerCase().includes(text.toLowerCase())) {
        return current; // already present — don't duplicate
      }
      return `${trimmed}\n${text}`;
    });
  };

  const derive = useCallback(async () => {
    const ready = files.filter((file) => file.state === "ready");
    const sources = ready.flatMap((entry) => entry.sources);
    const columns = sources.reduce((total, source) => total + source.fields.length, 0);

    // Every step here is work this component actually awaits. The AI draft is issued by the
    // Copilot after the canvas mounts, so it is a note below the rail — never a fake phase.
    const readStep: CreateStep | null =
      ready.length === 0
        ? null
        : {
            id: "read",
            label: "Source files read",
            detail: `${plural(ready.length, "file")} · ${plural(sources.length, "table")} · ${plural(columns, "column")}`,
            state: "done",
          };
    const saveStep: CreateStep = { id: "save", label: "Saving project", state: "active" };
    const sequence = readStep ? [readStep, saveStep] : [saveStep];

    setCreateError(undefined);
    setSteps(sequence);

    const timer = window.setTimeout(() => swapStage("creating"), MORPH_AFTER_MS);
    try {
      await onDerive({
        name: title.trim(),
        description: description.trim(),
        sources,
      });
      window.clearTimeout(timer);
      // Complete the rail. On success the editor takes over and this unmounts; setting it anyway
      // means a slow route transition ends on a finished sequence rather than a stalled one.
      setSteps(sequence.map((step) => ({ ...step, state: "done" })));
    } catch (failure) {
      window.clearTimeout(timer);
      const text = failure instanceof Error ? failure.message : "Something went wrong.";
      setSteps(sequence.map((step) => (step.id === "save" ? { ...step, state: "failed" } : step)));
      setCreateError(text);
      setStage((current) => {
        if (current === "creating") {
          return current;
        }
        morphFromRef.current = cardRef.current?.offsetHeight ?? null;
        return "creating";
      });
    }
  }, [files, title, description, onDerive, swapStage]);

  const summary = parsing
    ? `Reading ${settling.length === files.length ? plural(files.length, "file") : `${files.length - settling.length} of ${files.length} files`}…`
    : readyFiles.length === 0
      ? "No files yet"
      : `${plural(readyFiles.length, "file")} ready`;

  return (
    <div
      className="npm-scrim"
      onClick={(event) => {
        if (event.target === event.currentTarget && !busy) {
          onClose();
        }
      }}
    >
      <div
        className="npm-card"
        role="dialog"
        aria-modal="true"
        aria-labelledby="npm-title"
        aria-busy={busy}
        tabIndex={-1}
        ref={cardRef}
      >
        {/* Header — the anchor across the morph; it never swaps. */}
        <header className="npm-header">
          <span className="npm-header__badge" aria-hidden>
            <DatabaseIcon size={18} />
          </span>
          <div className="npm-header__text">
            <h2 className="npm-header__title" id="npm-title">
              New project
            </h2>
            <p className="npm-header__subtitle">
              {autoDraft
                ? "Drop your raw files and give Grafture context to infer the schema."
                : "Add source files to start from, or create an empty project — you can add files later."}
            </p>
          </div>
          <button
            type="button"
            className="npm-close"
            onClick={onClose}
            disabled={creating && createError === undefined}
            aria-label="Close"
          >
            <XIcon size={16} />
          </button>
        </header>

        {creating ? (
          <div className="npm-swap" key="creating">
            <CreateProgress
              title={title.trim() || "your project"}
              steps={steps}
              note={
                autoDraft && readyFiles.length > 0
                  ? "The Copilot drafts a first schema once the canvas opens."
                  : undefined
              }
              error={createError}
              onCancel={() => {
                setCreateError(undefined);
                swapStage("form");
              }}
              onRetry={() => void derive()}
            />
          </div>
        ) : (
          <div className="npm-swap" key="form">
            {/* Body */}
            <div className="npm-body">
              <section>
                <p className="npm-label">Source files</p>
                <button
                  type="button"
                  className={`npm-dropzone${dragging ? " is-dragging" : ""}`}
                  onClick={() => fileInputRef.current?.click()}
                  onDragOver={(event) => {
                    event.preventDefault();
                    setDragging(true);
                  }}
                  onDragLeave={() => setDragging(false)}
                  onDrop={onDrop}
                >
                  <span className="npm-dropzone__badge" aria-hidden>
                    <UploadIcon size={20} />
                  </span>
                  <span className="npm-dropzone__primary">
                    <span className="npm-dropzone__browse">Click to browse</span> or drag files here
                  </span>
                  <span className="npm-dropzone__hint">CSV, XLSX or JSON · up to 50 MB each</span>
                </button>
                <input
                  ref={fileInputRef}
                  type="file"
                  multiple
                  accept={ACCEPT}
                  className="npm-fileinput"
                  onChange={onPick}
                />

                {files.length > 0 ? (
                  <ul className="npm-filelist">
                    {files.map((file) => (
                      <li key={file.id} className="npm-filerow" data-state={file.state}>
                        <span className="npm-filerow__badge" aria-hidden>
                          <FileIcon size={15} />
                        </span>
                        <span className="npm-filerow__body">
                          <span className="npm-filerow__name">{file.name}</span>
                          <span className="npm-filerow__meta">{metaLine(file)}</span>
                        </span>
                        <button
                          type="button"
                          className="npm-filerow__remove"
                          onClick={() => removeFile(file.id)}
                          disabled={file.state === "parsing"}
                          aria-label={`Remove ${file.name}`}
                        >
                          <XIcon size={14} />
                        </button>
                      </li>
                    ))}
                  </ul>
                ) : null}
              </section>

              <section>
                <label className="npm-label" htmlFor="npm-name">
                  Project title
                </label>
                <input
                  id="npm-name"
                  className="npm-input"
                  type="text"
                  placeholder="e.g. Grant Reporting"
                  value={title}
                  onChange={(event) => setTitle(event.target.value)}
                />
              </section>

              <section>
                <div className="npm-labelrow">
                  <label className="npm-label" htmlFor="npm-desc">
                    Description &amp; goals
                  </label>
                  <span className="npm-hint">
                    {autoDraft ? "Helps infer joins & types" : "Shared with the Copilot as context"}
                  </span>
                </div>
                <textarea
                  id="npm-desc"
                  className="npm-textarea"
                  placeholder="What is this data and what are you trying to do with it? e.g. Reconcile grant disbursements across organizations and funding rounds; join on organization ID."
                  value={description}
                  onChange={(event) => setDescription(event.target.value)}
                />
                <div className="npm-chips">
                  {SUGGESTION_CHIPS.map((chip) => (
                    <button
                      key={chip}
                      type="button"
                      className="npm-chip"
                      onClick={() => appendChip(chip)}
                    >
                      <PlusIcon size={11} />
                      {chip}
                    </button>
                  ))}
                </div>
              </section>
            </div>

            {/* Footer */}
            <footer className="npm-footer">
              <span className={`npm-footer__summary${parsing ? " is-parsing" : ""}`}>
                {summary}
              </span>
              <div className="npm-footer__actions">
                <button type="button" className="npm-btn npm-btn--ghost" onClick={onClose}>
                  Cancel
                </button>
                <button
                  type="button"
                  className="npm-btn npm-btn--primary"
                  onClick={() => void derive()}
                  disabled={parsing}
                >
                  <FilePlusIcon size={15} />
                  {/* "Derive schema" only when there are files to derive from; an empty project is
                      always just "Create project", even with AI drafting on. */}
                  {autoDraft && readyFiles.length > 0 ? "Derive schema" : "Create project"}
                </button>
              </div>
            </footer>
          </div>
        )}
      </div>
    </div>
  );
}
