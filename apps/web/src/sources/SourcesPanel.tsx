import { ParseError, type Source } from "@grafture/core";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent,
  type ReactNode,
} from "react";

import { useSchemaStore } from "../store/index.js";
import type { PipelineStep } from "../ui/Pipeline.js";
import { BranchIcon, ChevronDownIcon, FileIcon, PanelOpenIcon, PlusIcon } from "../ui/icons.js";
import { addSourceFieldToTable, buildTableFromSource, formatSample } from "./buildFromSource.js";
import { childLabel, groupSources } from "./groupSources.js";
import { ParsingOverlay } from "./ParsingOverlay.js";
import "./SourcesPanel.css";
import { nextPaint } from "./nextPaint.js";
import { readAndParseFile } from "./readAndParse.js";

const ACCEPTED_EXTENSIONS = ".csv,.tsv,.xlsx,.xls,.json";

/**
 * How long parsing may run before the overlay appears. Under this, the files are read before a
 * progress surface would have been legible and flashing one is worse than showing nothing.
 */
const OVERLAY_AFTER_MS = 180;

type PanelMessage = { kind: "error"; text: string } | { kind: "info"; text: string } | null;

function rejectionSummary(rejected: Array<{ reason: string }>): string {
  return rejected.map((item) => item.reason).join("; ");
}

function SourceCard({
  sourceId,
  name,
  title,
  kind,
  fieldCount,
  rowCount,
  nestedCount = 0,
  nested = false,
  tourAnchor = false,
  expanded,
  onToggle,
  onBuildTable,
  onRemove,
  children,
}: {
  sourceId: string;
  name: string;
  /** Full source name for the tooltip — a nested card shows only its JSON key as `name`. */
  title: string;
  kind: string;
  fieldCount: number;
  rowCount: number | undefined;
  /** Child sources unnested from this one; shown as a count so a collapsed group still says so. */
  nestedCount?: number;
  /** A child source, rendered indented under its parent. */
  nested?: boolean;
  /** Carries the onboarding tour's `source-card` / `build-table` anchors (the first card only). */
  tourAnchor?: boolean;
  expanded: boolean;
  onToggle: () => void;
  onBuildTable: () => void;
  onRemove: () => void;
  children: ReactNode;
}) {
  const meta = [
    ...(nested ? [] : [kind.toUpperCase()]),
    `${fieldCount} fields`,
    // Sources parsed before rowCount existed simply omit the segment.
    ...(rowCount !== undefined
      ? [`${rowCount.toLocaleString()} ${rowCount === 1 ? "row" : "rows"}`]
      : []),
    ...(nestedCount > 0 ? [`${nestedCount} nested`] : []),
  ].join(" · ");

  return (
    <article
      className={`sources-panel__source${expanded ? " is-expanded" : ""}${
        nested ? " sources-panel__source--nested" : ""
      }`}
      data-source-id={sourceId}
      {...(tourAnchor ? { "data-tour": "source-card" } : {})}
    >
      <button
        type="button"
        className="sources-panel__source-header"
        onClick={onToggle}
        aria-expanded={expanded}
      >
        <span className="sources-panel__source-icon">
          {nested ? <BranchIcon size={16} /> : <FileIcon size={16} />}
        </span>
        <span className="sources-panel__source-meta">
          <span className="sources-panel__source-name" title={title}>
            {name}
          </span>
          <span className="sources-panel__source-kind">{meta}</span>
        </span>
        <ChevronDownIcon size={16} className="sources-panel__chevron" />
      </button>
      {expanded ? (
        <div className="sources-panel__source-body">
          {children}
          <div
            className="sources-panel__source-actions"
            {...(tourAnchor ? { "data-tour": "build-table" } : {})}
          >
            <button type="button" className="sources-panel__button" onClick={onBuildTable}>
              Build table
            </button>
            <button
              type="button"
              className="sources-panel__button sources-panel__button--ghost"
              onClick={onRemove}
              aria-label={`Remove ${title}`}
            >
              Remove
            </button>
          </div>
        </div>
      ) : null}
    </article>
  );
}

export function SourcesPanel({
  collapsed,
  onToggleCollapse,
  tourExpandFirst = false,
}: {
  collapsed: boolean;
  onToggleCollapse: () => void;
  /**
   * The onboarding tour's "Build table" step needs the first card open to have anything to point
   * at. It borrows the accordion for the length of that step and the panel puts back whatever was
   * expanded before — the tour never leaves the panel rearranged.
   */
  tourExpandFirst?: boolean;
}) {
  const fileInputRef = useRef<HTMLInputElement>(null);
  // Tracks drag enter/leave depth so the overlay doesn't flicker as the cursor
  // moves between the pane and its nested children.
  const dragDepth = useRef(0);
  const [dragActive, setDragActive] = useState(false);
  const [message, setMessage] = useState<PanelMessage>(null);
  const [busy, setBusy] = useState(false);
  // One step per file in the current ingest. `settled` flips the overlay from a live count to a
  // dismissible failure report; `overlayShown` gates it on the anti-flash delay below.
  const [steps, setSteps] = useState<PipelineStep[]>([]);
  const [settled, setSettled] = useState(false);
  const [overlayShown, setOverlayShown] = useState(false);
  // Accordion: at most one source expanded at a time. `null` means all collapsed (the default).
  const [expandedSourceId, setExpandedSourceId] = useState<string | null>(null);

  const sources = useSchemaStore((state) => state.sources);
  const schema = useSchemaStore((state) => state.schema);
  const selection = useSchemaStore((state) => state.selection);
  const addSources = useSchemaStore((state) => state.addSources);
  const removeSource = useSchemaStore((state) => state.removeSource);
  const runActions = useSchemaStore((state) => state.runActions);
  const addField = useSchemaStore((state) => state.addField);
  const selectTable = useSchemaStore((state) => state.selectTable);

  const activeTable = selection.tableId
    ? schema.tables.find((table) => table.id === selection.tableId)
    : undefined;

  // One card per uploaded file, with the sources unnested from a JSON file's array fields nested
  // under it. The panel's file count follows the groups, not the raw source count.
  const groups = useMemo(() => groupSources(sources), [sources]);

  const toggleSource = (sourceId: string) => {
    setExpandedSourceId((current) => (current === sourceId ? null : sourceId));
  };

  // What was expanded before the tour borrowed the accordion. `undefined` means "not borrowed",
  // which is how a restore knows it has nothing to put back. `tourOpened` is which card the tour
  // opened, so the restore can tell its own change from the user's.
  const preTourExpanded = useRef<string | null | undefined>(undefined);
  const tourOpened = useRef<string | null>(null);
  const expandedRef = useRef(expandedSourceId);
  expandedRef.current = expandedSourceId;

  useEffect(() => {
    if (!tourExpandFirst) {
      if (preTourExpanded.current !== undefined) {
        // Put back only what is still the tour's. The tour is non-blocking, so the user may well
        // have opened a different card while it was on this step — reverting that would be the
        // overlay undoing a deliberate click, which is worse than leaving the panel as they left it.
        if (expandedRef.current === tourOpened.current) {
          setExpandedSourceId(preTourExpanded.current);
        }
        preTourExpanded.current = undefined;
        tourOpened.current = null;
      }
      return;
    }
    const first = groups[0]?.root.id;
    if (!first) {
      return;
    }
    if (preTourExpanded.current === undefined) {
      preTourExpanded.current = expandedRef.current;
    }
    tourOpened.current = first;
    setExpandedSourceId(first);
  }, [tourExpandFirst, groups]);

  const ingestFiles = useCallback(
    async (files: FileList | File[]) => {
      const list = Array.from(files);
      if (list.length === 0) {
        return;
      }

      setBusy(true);
      setMessage(null);
      setSettled(false);
      // Seed one step per file up front so the overlay opens showing the whole queue, not a
      // list that grows a row at a time.
      setSteps(
        list.map((file, index) => ({
          id: `${index}:${file.name}`,
          label: file.name,
          state: "pending",
        })),
      );

      // A handful of small CSVs parse in well under a frame. Showing the overlay for 40ms reads
      // as a glitch, so it only appears if the work actually outlives the delay — the same floor
      // the New Project modal uses before morphing.
      const reveal = window.setTimeout(() => setOverlayShown(true), OVERLAY_AFTER_MS);

      const patch = (id: string, next: Partial<PipelineStep>) => {
        setSteps((current) =>
          current.map((step) => (step.id === id ? { ...step, ...next } : step)),
        );
      };

      let failures = 0;

      // Sequential on purpose: parsing is synchronous CPU work, so running it in parallel would
      // interleave into one long freeze with nothing to show. One at a time gives every file a
      // real parsing state and keeps the frame budget for painting it.
      for (const [index, file] of list.entries()) {
        const id = `${index}:${file.name}`;
        patch(id, { state: "active" });
        await nextPaint();
        try {
          const parsed = await readAndParseFile(file);
          addSources(parsed);
          const columns = parsed[0]?.fields.length ?? 0;
          const nested = parsed.length - 1;
          patch(id, {
            state: "done",
            detail: `${columns} ${columns === 1 ? "column" : "columns"}${
              nested > 0 ? ` · ${nested} nested ${nested === 1 ? "table" : "tables"}` : ""
            }`,
          });
        } catch (error) {
          failures += 1;
          // The reason only — the step's own label above it is the file name, and ParseError
          // deliberately keeps the name out of `message` (see core's ParseError).
          const text =
            error instanceof ParseError || error instanceof Error
              ? error.message
              : "Failed to parse file";
          patch(id, { state: "failed", detail: text });
        }
      }

      window.clearTimeout(reveal);
      setBusy(false);

      if (failures === 0) {
        // Silent success: the new source cards behind the overlay are the confirmation, so close
        // rather than make the user dismiss a banner that only says what they can already see.
        setSteps([]);
        setOverlayShown(false);
      } else {
        // A failure must be readable regardless of how fast it happened — an unparseable file
        // fails almost instantly, which is exactly when the anti-flash delay would have hidden it.
        setSettled(true);
        setOverlayShown(true);
      }
    },
    [addSources],
  );

  const openFilePicker = () => {
    fileInputRef.current?.click();
  };

  const handleBuildTable = (sourceId: string) => {
    const source = sources.find((candidate) => candidate.id === sourceId);
    if (!source) {
      return;
    }

    const result = buildTableFromSource(runActions, schema, source, sources);

    if (result.rejected.length > 0) {
      setMessage({ kind: "error", text: rejectionSummary(result.rejected) });
      return;
    }

    const newTableId = result.applied[0]?.tableIds[0];
    if (newTableId) {
      selectTable(newTableId);
    }

    setMessage({
      kind: "info",
      text: `Built table "${result.tableName}" from ${source.name}.`,
    });
  };

  const handleAddField = (sourceId: string, fieldName: string) => {
    const source = sources.find((candidate) => candidate.id === sourceId);
    const field = source?.fields.find((candidate) => candidate.name === fieldName);

    if (!field) {
      return;
    }

    const result = addSourceFieldToTable(addField, selection.tableId, field);

    if ("error" in result) {
      setMessage({ kind: "error", text: result.error });
      return;
    }

    if (result.rejected.length > 0) {
      setMessage({ kind: "error", text: rejectionSummary(result.rejected) });
      return;
    }

    setMessage({
      kind: "info",
      text: `Added "${field.name}" to ${activeTable?.name ?? "the active table"}.`,
    });
  };

  const isFileDrag = (event: DragEvent) => Array.from(event.dataTransfer.types).includes("Files");

  const handleDragEnter = (event: DragEvent) => {
    if (!isFileDrag(event)) {
      return;
    }
    event.preventDefault();
    dragDepth.current += 1;
    setDragActive(true);
  };

  const handleDragOver = (event: DragEvent) => {
    if (isFileDrag(event)) {
      event.preventDefault();
    }
  };

  const handleDragLeave = (event: DragEvent) => {
    event.preventDefault();
    dragDepth.current -= 1;
    if (dragDepth.current <= 0) {
      dragDepth.current = 0;
      setDragActive(false);
    }
  };

  const handleDrop = (event: DragEvent) => {
    event.preventDefault();
    dragDepth.current = 0;
    setDragActive(false);
    void ingestFiles(event.dataTransfer.files);
  };

  /** One source card with its clickable field list. Parent and nested cards render identically. */
  const renderCard = (
    source: Source,
    opts: { nested?: boolean; nestedCount?: number; tourAnchor?: boolean },
  ) => (
    <SourceCard
      key={source.id}
      sourceId={source.id}
      name={opts.nested ? childLabel(source) : source.name}
      title={source.name}
      kind={source.kind}
      fieldCount={source.fields.length}
      rowCount={source.rowCount}
      {...(opts.nested ? { nested: true } : {})}
      {...(opts.nestedCount ? { nestedCount: opts.nestedCount } : {})}
      {...(opts.tourAnchor ? { tourAnchor: true } : {})}
      expanded={expandedSourceId === source.id}
      onToggle={() => toggleSource(source.id)}
      onBuildTable={() => handleBuildTable(source.id)}
      onRemove={() => removeSource(source.id)}
    >
      <ul className="sources-panel__fields">
        {source.fields.map((field, index) => {
          const sample = formatSample(field);

          return (
            <li key={field.name}>
              <button
                type="button"
                className="sources-panel__field"
                disabled={!selection.tableId}
                title={
                  selection.tableId
                    ? `Add ${field.name} to ${activeTable?.name ?? "active table"}`
                    : "Select an active table first"
                }
                onClick={() => handleAddField(source.id, field.name)}
              >
                <span className={`sources-panel__dot${index === 0 ? " is-pk" : ""}`} aria-hidden />
                <span className="sources-panel__field-name">{field.name}</span>
                <span className="sources-panel__field-type">{field.type}</span>
                <span className="sources-panel__field-sample">
                  {sample !== null ? sample : "—"}
                </span>
              </button>
            </li>
          );
        })}
      </ul>
    </SourceCard>
  );

  if (collapsed) {
    return (
      <aside className="panel panel-rail">
        <button
          type="button"
          className="panel-rail__btn"
          onClick={onToggleCollapse}
          title="Expand sources"
          aria-label="Expand sources panel"
        >
          <PanelOpenIcon size={16} />
        </button>
        <span className="panel-rail__label">Sources</span>
      </aside>
    );
  }

  return (
    <section
      className="panel sources-panel"
      onDragEnter={handleDragEnter}
      onDragOver={handleDragOver}
      onDragLeave={handleDragLeave}
      onDrop={handleDrop}
    >
      <header className="sources-panel__header">
        <div className="sources-panel__title-group">
          <h1 className="sources-panel__title">Sources</h1>
          <span className="sources-panel__subtitle">
            {groups.length} {groups.length === 1 ? "file" : "files"}
          </span>
        </div>
        <div className="sources-panel__header-actions">
          <button
            type="button"
            className="sources-panel__add"
            onClick={openFilePicker}
            disabled={busy}
            aria-label="Add source file"
            title="Add a local file"
          >
            <PlusIcon size={16} />
          </button>
          <button
            type="button"
            className="sources-panel__add"
            onClick={onToggleCollapse}
            aria-label="Collapse sources panel"
            title="Collapse panel"
          >
            <PanelOpenIcon size={16} />
          </button>
        </div>
      </header>
      <div className="panel-body">
        {sources.length === 0 ? (
          <div
            className="sources-panel__dropzone"
            data-tour="sources-empty"
            onClick={openFilePicker}
            role="button"
            tabIndex={0}
            onKeyDown={(event) => {
              if (event.key === "Enter" || event.key === " ") {
                event.preventDefault();
                openFilePicker();
              }
            }}
          >
            <strong>Drop files here</strong>
            <span>or click to choose CSV, Excel, or JSON</span>
            <span>Parsed in your browser — never uploaded</span>
          </div>
        ) : null}

        <input
          ref={fileInputRef}
          className="sources-panel__file-input"
          type="file"
          accept={ACCEPTED_EXTENSIONS}
          multiple
          disabled={busy}
          onChange={(event) => {
            const { files } = event.target;
            if (files) {
              void ingestFiles(files);
            }
            event.target.value = "";
          }}
        />

        {message ? (
          <p className={`sources-panel__message sources-panel__message--${message.kind}`}>
            {message.text}
          </p>
        ) : null}

        {schema.tables.length > 0 ? (
          <p className="sources-panel__hint">
            {activeTable
              ? `Active table: ${activeTable.name} — click a field below to add it.`
              : "Pick an active table from the canvas, then click a field to add it."}
          </p>
        ) : (
          <p className="sources-panel__hint">
            Build a table from a file, or add tables on the canvas, then add individual fields.
          </p>
        )}

        {sources.length === 0 ? (
          <p className="sources-panel__empty">
            No sources yet. Upload a file to inspect its fields.
          </p>
        ) : (
          groups.map((group, groupIndex) => (
            <div className="sources-panel__group" key={group.root.id}>
              {renderCard(group.root, {
                nestedCount: group.children.length,
                tourAnchor: groupIndex === 0,
              })}
              {group.children.length > 0 ? (
                <div className="sources-panel__nested">
                  {group.children.map((child) => renderCard(child, { nested: true }))}
                </div>
              ) : null}
            </div>
          ))
        )}
      </div>

      {overlayShown && steps.length > 0 ? (
        <ParsingOverlay
          steps={steps}
          settled={settled}
          onDismiss={() => {
            setSteps([]);
            setSettled(false);
            setOverlayShown(false);
          }}
        />
      ) : null}

      {dragActive ? (
        <div className="sources-panel__drag-overlay" aria-hidden>
          <div className="sources-panel__drag-card">
            <strong>Drop files to add</strong>
            <span>CSV, Excel, or JSON — parsed in your browser</span>
          </div>
        </div>
      ) : null}
    </section>
  );
}
