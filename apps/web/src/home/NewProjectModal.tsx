import type { Source } from "@schema-studio/core";
import { ParseError } from "@schema-studio/core";
import { useCallback, useEffect, useRef, useState } from "react";

import { readAndParseFile } from "../sources/readAndParse.js";
import { DatabaseIcon, FileIcon, FilePlusIcon, PlusIcon, UploadIcon, XIcon } from "../ui/icons.js";
import "./NewProjectModal.css";

/** A parsed, ready-to-add source plus the display facts we can show truthfully (no row totals). */
type PreparedFile = {
  id: string;
  name: string;
  source: Source;
  /** Bytes of the original file, for the meta line. */
  size: number;
};

export type DeriveInput = { name: string; description: string; sources: Source[] };

const ACCEPT = ".csv,.xlsx,.json";

/** Goal chips that seed the description — phrased as the content-aware things the engine reasons about. */
const SUGGESTION_CHIPS = [
  "Find joins between tables",
  "Flag type mismatches",
  "Deduplicate records",
];

function formatSize(bytes: number): string {
  if (bytes < 1024) {
    return `${bytes} B`;
  }
  if (bytes < 1024 * 1024) {
    return `${Math.round(bytes / 1024)} KB`;
  }
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function metaLine(file: PreparedFile): string {
  const columns = file.source.fields.length;
  return `${columns} ${columns === 1 ? "column" : "columns"} · ${formatSize(file.size)}`;
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
 */
export function NewProjectModal({
  onClose,
  onDerive,
  autoDraft,
}: {
  onClose: () => void;
  onDerive: (input: DeriveInput) => void;
  /** The experimental AI schema-drafting preference; gates the "derive schema" framing. */
  autoDraft: boolean;
}) {
  const [files, setFiles] = useState<PreparedFile[]>([]);
  const [dragging, setDragging] = useState(false);
  const [busy, setBusy] = useState(false);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [error, setError] = useState<string | null>(null);

  const fileInputRef = useRef<HTMLInputElement>(null);
  const cardRef = useRef<HTMLDivElement>(null);

  const hasFiles = files.length > 0;

  // Esc to close + lock background scroll while open.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
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
  }, [onClose]);

  // Move focus into the dialog on open for keyboard users.
  useEffect(() => {
    cardRef.current?.focus();
  }, []);

  const ingest = useCallback(async (incoming: FileList | File[]) => {
    const list = Array.from(incoming);
    if (list.length === 0) {
      return;
    }
    setBusy(true);
    setError(null);

    const prepared: PreparedFile[] = [];
    const errors: string[] = [];
    for (const file of list) {
      try {
        const source = await readAndParseFile(file);
        prepared.push({ id: source.id, name: file.name, source, size: file.size });
      } catch (failure) {
        const text =
          failure instanceof ParseError || failure instanceof Error
            ? failure.message
            : "Failed to parse file";
        errors.push(`${file.name}: ${text}`);
      }
    }

    if (prepared.length > 0) {
      // De-dupe by name so re-dropping the same file replaces rather than stacks it.
      setFiles((current) => {
        const byName = new Map(current.map((entry) => [entry.name, entry]));
        for (const entry of prepared) {
          byName.set(entry.name, entry);
        }
        return Array.from(byName.values());
      });
    }
    if (errors.length > 0) {
      setError(errors.join(" "));
    }
    setBusy(false);
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

  const derive = () => {
    onDerive({
      name: title.trim(),
      description: description.trim(),
      sources: files.map((entry) => entry.source),
    });
  };

  const summary =
    files.length === 0
      ? "No files yet"
      : files.length === 1
        ? "1 file ready"
        : `${files.length} files ready`;

  return (
    <div
      className="npm-scrim"
      onClick={(event) => {
        if (event.target === event.currentTarget) {
          onClose();
        }
      }}
    >
      <div
        className="npm-card"
        role="dialog"
        aria-modal="true"
        aria-labelledby="npm-title"
        tabIndex={-1}
        ref={cardRef}
      >
        {/* Header */}
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
                ? "Drop your raw files and give Schema Studio context to infer the schema."
                : "Add source files to start from, or create an empty project — you can add files later."}
            </p>
          </div>
          <button type="button" className="npm-close" onClick={onClose} aria-label="Close">
            <XIcon size={16} />
          </button>
        </header>

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

            {hasFiles ? (
              <ul className="npm-filelist">
                {files.map((file) => (
                  <li key={file.id} className="npm-filerow">
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
                      aria-label={`Remove ${file.name}`}
                    >
                      <XIcon size={14} />
                    </button>
                  </li>
                ))}
              </ul>
            ) : null}

            {busy ? <p className="npm-note">Parsing files locally…</p> : null}
            {error ? <p className="npm-note npm-note--error">{error}</p> : null}
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
          <span className="npm-footer__summary">{summary}</span>
          <div className="npm-footer__actions">
            <button type="button" className="npm-btn npm-btn--ghost" onClick={onClose}>
              Cancel
            </button>
            <button type="button" className="npm-btn npm-btn--primary" onClick={derive}>
              <FilePlusIcon size={15} />
              {/* "Derive schema" only when there are files to derive from; an empty project is
                  always just "Create project", even with AI drafting on. */}
              {autoDraft && hasFiles ? "Derive schema" : "Create project"}
            </button>
          </div>
        </footer>
      </div>
    </div>
  );
}
