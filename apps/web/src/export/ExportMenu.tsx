import type { Schema } from "@schema-studio/core";
import { toDbml, toPrisma, toSql } from "@schema-studio/core";
import { useMemo, useState } from "react";

import { useSchemaStore } from "../store/index.js";
import "./ExportMenu.css";

type ExportFormat = {
  id: "dbml" | "sql" | "prisma";
  label: string;
  extension: string;
  mime: string;
  run: (schema: Schema) => string;
};

const FORMAT_BY_ID: Record<ExportFormat["id"], ExportFormat> = {
  dbml: { id: "dbml", label: "DBML", extension: "dbml", mime: "text/plain", run: toDbml },
  sql: {
    id: "sql",
    label: "SQL",
    extension: "sql",
    mime: "application/sql",
    run: (schema) => toSql(schema),
  },
  prisma: { id: "prisma", label: "Prisma", extension: "prisma", mime: "text/plain", run: toPrisma },
};

const FORMATS: ExportFormat[] = [FORMAT_BY_ID.dbml, FORMAT_BY_ID.sql, FORMAT_BY_ID.prisma];

export function ExportMenu() {
  const schema = useSchemaStore((state) => state.schema);
  const [open, setOpen] = useState(false);
  const [formatId, setFormatId] = useState<ExportFormat["id"]>("dbml");
  const [copied, setCopied] = useState(false);

  const format = FORMAT_BY_ID[formatId];
  const output = useMemo(() => format.run(schema), [format, schema]);
  const hasTables = schema.tables.length > 0;

  const selectFormat = (id: ExportFormat["id"]) => {
    setFormatId(id);
    setCopied(false);
  };

  const handleCopy = async () => {
    try {
      await navigator.clipboard.writeText(output);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  };

  const handleDownload = () => {
    const blob = new Blob([output], { type: format.mime });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `schema.${format.extension}`;
    anchor.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="export-menu">
      <button
        type="button"
        className="export-menu__toggle"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
      >
        Export
      </button>

      {open ? (
        <div className="export-menu__panel" role="dialog" aria-label="Export schema">
          <div className="export-menu__tabs">
            {FORMATS.map((candidate) => (
              <button
                key={candidate.id}
                type="button"
                className={`export-menu__tab${candidate.id === formatId ? " is-active" : ""}`}
                onClick={() => selectFormat(candidate.id)}
              >
                {candidate.label}
              </button>
            ))}
          </div>

          {hasTables ? (
            <>
              <pre className="export-menu__code">{output}</pre>
              <div className="export-menu__actions">
                <button type="button" onClick={() => void handleCopy()}>
                  {copied ? "Copied" : "Copy"}
                </button>
                <button type="button" onClick={handleDownload}>
                  Download .{format.extension}
                </button>
              </div>
            </>
          ) : (
            <p className="export-menu__empty">
              Add tables to the canvas or build one from a file to export.
            </p>
          )}
        </div>
      ) : null}
    </div>
  );
}
