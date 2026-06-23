import { ParseError } from "@schema-studio/core";
import { useCallback, useRef, useState, type ReactNode } from "react";

import { useSchemaStore } from "../store/index.js";
import { addSourceFieldToTable, buildTableFromSource, formatSample } from "./buildFromSource.js";
import "./SourcesPanel.css";
import { readAndParseFile } from "./readAndParse.js";

const ACCEPTED_EXTENSIONS = ".csv,.tsv,.xlsx,.xls,.json";

type PanelMessage = { kind: "error"; text: string } | { kind: "info"; text: string } | null;

function rejectionSummary(rejected: Array<{ reason: string }>): string {
  return rejected.map((item) => item.reason).join("; ");
}

function SourceCard({
  sourceId,
  name,
  kind,
  fieldCount,
  onBuildTable,
  onRemove,
  children,
}: {
  sourceId: string;
  name: string;
  kind: string;
  fieldCount: number;
  onBuildTable: () => void;
  onRemove: () => void;
  children: ReactNode;
}) {
  return (
    <article className="sources-panel__source" data-source-id={sourceId}>
      <header className="sources-panel__source-header">
        <div className="sources-panel__source-meta">
          <span className="sources-panel__source-name" title={name}>
            {name}
          </span>
          <span className="sources-panel__source-kind">
            {kind} · {fieldCount} fields
          </span>
        </div>
        <div className="sources-panel__source-actions">
          <button type="button" className="sources-panel__button" onClick={onBuildTable}>
            Build table
          </button>
          <button
            type="button"
            className="sources-panel__button sources-panel__button--ghost"
            onClick={onRemove}
            aria-label={`Remove ${name}`}
          >
            Remove
          </button>
        </div>
      </header>
      {children}
    </article>
  );
}

export function SourcesPanel() {
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [dragActive, setDragActive] = useState(false);
  const [message, setMessage] = useState<PanelMessage>(null);
  const [busy, setBusy] = useState(false);

  const sources = useSchemaStore((state) => state.sources);
  const schema = useSchemaStore((state) => state.schema);
  const selection = useSchemaStore((state) => state.selection);
  const addSource = useSchemaStore((state) => state.addSource);
  const removeSource = useSchemaStore((state) => state.removeSource);
  const runActions = useSchemaStore((state) => state.runActions);
  const addField = useSchemaStore((state) => state.addField);
  const selectTable = useSchemaStore((state) => state.selectTable);

  const activeTable = selection.tableId
    ? schema.tables.find((table) => table.id === selection.tableId)
    : undefined;

  const ingestFiles = useCallback(
    async (files: FileList | File[]) => {
      const list = Array.from(files);
      if (list.length === 0) {
        return;
      }

      setBusy(true);
      setMessage(null);

      const errors: string[] = [];
      let added = 0;

      for (const file of list) {
        try {
          const source = await readAndParseFile(file);
          addSource(source);
          added += 1;
        } catch (error) {
          const text =
            error instanceof ParseError
              ? error.message
              : error instanceof Error
                ? error.message
                : "Failed to parse file";
          errors.push(`${file.name}: ${text}`);
        }
      }

      if (errors.length > 0) {
        setMessage({ kind: "error", text: errors.join(" ") });
      } else if (added > 0) {
        setMessage({
          kind: "info",
          text:
            added === 1
              ? "File parsed locally — nothing was uploaded."
              : `${added} files parsed locally — nothing was uploaded.`,
        });
      }

      setBusy(false);
    },
    [addSource],
  );

  const openFilePicker = () => {
    fileInputRef.current?.click();
  };

  const handleBuildTable = (sourceId: string) => {
    const source = sources.find((candidate) => candidate.id === sourceId);
    if (!source) {
      return;
    }

    const result = buildTableFromSource(runActions, schema, source);

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

  return (
    <section className="panel sources-panel">
      <header className="panel-header">Sources</header>
      <div className="panel-body">
        <div
          className={`sources-panel__dropzone${dragActive ? " sources-panel__dropzone--active" : ""}`}
          onClick={openFilePicker}
          onDragEnter={(event) => {
            event.preventDefault();
            setDragActive(true);
          }}
          onDragOver={(event) => {
            event.preventDefault();
            setDragActive(true);
          }}
          onDragLeave={(event) => {
            event.preventDefault();
            if (event.currentTarget === event.target) {
              setDragActive(false);
            }
          }}
          onDrop={(event) => {
            event.preventDefault();
            setDragActive(false);
            void ingestFiles(event.dataTransfer.files);
          }}
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
          <label className="sources-panel__hint">
            Active table{" "}
            <select
              className="sources-panel__table-select"
              value={selection.tableId ?? ""}
              onChange={(event) => {
                const tableId = event.target.value;
                selectTable(tableId || undefined);
              }}
            >
              <option value="">Select a table…</option>
              {schema.tables.map((table) => (
                <option key={table.id} value={table.id}>
                  {table.name}
                </option>
              ))}
            </select>
            {activeTable ? " — click a field to add it." : " — required to add individual fields."}
          </label>
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
          sources.map((source) => (
            <SourceCard
              key={source.id}
              sourceId={source.id}
              name={source.name}
              kind={source.kind}
              fieldCount={source.fields.length}
              onBuildTable={() => handleBuildTable(source.id)}
              onRemove={() => removeSource(source.id)}
            >
              <ul className="sources-panel__fields">
                {source.fields.map((field) => {
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
                        <span className="sources-panel__field-name">{field.name}</span>
                        <span className="sources-panel__field-type">{field.type}</span>
                        {sample !== null ? (
                          <span className="sources-panel__field-sample">
                            e.g. &quot;{sample}&quot;
                          </span>
                        ) : (
                          <span className="sources-panel__field-sample">no samples</span>
                        )}
                      </button>
                    </li>
                  );
                })}
              </ul>
            </SourceCard>
          ))
        )}
      </div>
    </section>
  );
}
