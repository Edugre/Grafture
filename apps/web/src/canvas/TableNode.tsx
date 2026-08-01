import type { Field, Table } from "@grafture/core";
import { Handle, NodeResizeControl, Position } from "@xyflow/react";
import type { Node, NodeProps } from "@xyflow/react";
import { useState } from "react";

import { useSchemaStore } from "../store/index.js";
import { MIN_NODE_WIDTH, NODE_WIDTH } from "./constants.js";
import {
  type TableOrigin,
  isStaleRationale,
  isTouched,
  originOf,
  provenanceLabel,
  tableOrigin,
} from "./provenance.js";

/**
 * The provenance affordance: a small marker plus, where one exists, a rationale badge. Rendered
 * only in review mode.
 *
 * Deliberately NOT a background tint. `--surface-hover` is already the field-selection background
 * and the accent ring is node selection, so background and border carry transient state; a
 * persistent wash over every node would outrank the states that actually need attention. The
 * marker is a left edge (fields) or a dot (table title), and `data-origin` drives its colour while
 * `title` carries the same meaning in words — hue alone must never be the channel.
 */
function ProvenanceMarker({
  origin,
  touched,
  what,
}: {
  origin: TableOrigin;
  touched: boolean;
  what?: string;
}) {
  const label = provenanceLabel(origin, {
    touched,
    ...(what === undefined ? {} : { what }),
  });

  return (
    <span
      className={`provenance-dot${touched ? " is-touched" : ""}`}
      data-origin={origin}
      title={label}
      aria-label={label}
      role="img"
    />
  );
}

/**
 * The badge is a real button, not a tooltip-only affordance: the title attribute truncates long
 * reasoning and is unreachable by keyboard, and the reasoning is the point of the feature. It
 * opens the full text, its cited evidence, and its staleness in the review panel.
 */
function RationaleBadge({
  text,
  stale,
  onOpen,
}: {
  text: string;
  stale: boolean;
  onOpen: () => void;
}) {
  const label = stale ? `Why (edited since): ${text}` : `Why: ${text}`;

  return (
    <button
      type="button"
      className={`rationale-badge nodrag${stale ? " is-stale" : ""}`}
      title={label}
      aria-label={label}
      onClick={(event) => {
        // The row selects a field and the title starts a rename — neither is what a click on the
        // badge means.
        event.stopPropagation();
        onOpen();
      }}
      onDoubleClick={(event) => event.stopPropagation()}
    >
      {stale ? "?" : "i"}
    </button>
  );
}

export type TableNodeData = { table: Table; proposed?: boolean };
export type TableFlowNode = Node<TableNodeData, "table">;

/** Suggested data types offered in the field-type editor's datalist (free-form is still allowed). */
const COMMON_FIELD_TYPES = [
  "text",
  "int",
  "bigint",
  "float",
  "numeric",
  "boolean",
  "date",
  "timestamp",
  "uuid",
  "json",
];

function FieldRow({ table, field }: { table: Table; field: Field }) {
  const togglePk = useSchemaStore((state) => state.togglePk);
  const removeField = useSchemaStore((state) => state.removeField);
  const renameField = useSchemaStore((state) => state.renameField);
  const setFieldType = useSchemaStore((state) => state.setFieldType);
  const selectField = useSchemaStore((state) => state.selectField);
  const selectedFieldId = useSchemaStore((state) => state.selection.fieldId);
  const reviewMode = useSchemaStore((state) => state.reviewMode);
  const focusRationale = useSchemaStore((state) => state.focusRationale);

  const selected = selectedFieldId === field.id;
  const origin = originOf(field);
  const touched = isTouched(field);
  const rationale = field.provenance?.rationale;

  // At most one inline editor open at a time: the name or the type.
  const [editing, setEditing] = useState<"name" | "type" | null>(null);
  const [draft, setDraft] = useState("");

  const startEdit = (which: "name" | "type") => {
    setDraft(which === "name" ? field.name : field.type);
    setEditing(which);
  };

  const commit = () => {
    if (editing === "name") {
      renameField(table.id, field.id, draft);
    } else if (editing === "type") {
      setFieldType(table.id, field.id, draft);
    }
    setEditing(null);
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter") {
      commit();
    } else if (event.key === "Escape") {
      setEditing(null);
    }
  };

  return (
    <div
      className={`table-node__field${selected ? " is-selected" : ""}${
        reviewMode ? " is-reviewed" : ""
      }${reviewMode && touched ? " is-touched" : ""}`}
      {...(reviewMode
        ? { "data-origin": origin, title: provenanceLabel(origin, { touched }) }
        : {})}
      onClick={() => selectField(table.id, field.id)}
    >
      {/* Field-level connection handles: relationships attach to a field, not the table. */}
      <Handle
        type="target"
        position={Position.Left}
        id={field.id}
        className="field-handle field-handle--target"
      />
      <button
        type="button"
        className={`table-node__pk${field.pk ? " is-pk" : ""}`}
        title={field.pk ? "Primary key — click to unset" : "Click to mark as primary key"}
        onClick={(event) => {
          event.stopPropagation();
          togglePk(table.id, field.id);
        }}
      />

      {editing === "name" ? (
        // While renaming, the input spans the whole row (no type chip / remove competing for
        // width) so the full field name is easy to read and edit.
        <input
          className="table-node__field-input table-node__field-input--wide nodrag"
          value={draft}
          autoFocus
          onClick={(event) => event.stopPropagation()}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={commit}
          onKeyDown={onKeyDown}
        />
      ) : (
        <>
          <span
            className="table-node__field-name"
            title="Double-click to rename"
            onDoubleClick={(event) => {
              event.stopPropagation();
              startEdit("name");
            }}
          >
            {field.name}
          </span>
          {field.fk ? <span className="table-node__fk">FK</span> : null}
          {reviewMode && rationale ? (
            <RationaleBadge
              text={rationale.text}
              stale={isStaleRationale(field)}
              onOpen={() => focusRationale({ kind: "field", tableId: table.id, fieldId: field.id })}
            />
          ) : null}
          {editing === "type" ? (
            <>
              <input
                className="table-node__type-input nodrag"
                list="table-node-field-types"
                value={draft}
                autoFocus
                onClick={(event) => event.stopPropagation()}
                onChange={(event) => setDraft(event.target.value)}
                onBlur={commit}
                onKeyDown={onKeyDown}
              />
              <datalist id="table-node-field-types">
                {COMMON_FIELD_TYPES.map((type) => (
                  <option key={type} value={type} />
                ))}
              </datalist>
            </>
          ) : (
            <span
              className="table-node__type"
              title="Double-click to edit type"
              onDoubleClick={(event) => {
                event.stopPropagation();
                startEdit("type");
              }}
            >
              {field.type}
            </span>
          )}
          <button
            type="button"
            className="table-node__remove"
            title="Remove field"
            onClick={(event) => {
              event.stopPropagation();
              removeField(table.id, field.id);
            }}
          >
            ×
          </button>
        </>
      )}
      <Handle
        type="source"
        position={Position.Right}
        id={field.id}
        className="field-handle field-handle--source"
      />
    </div>
  );
}

function TableTitle({ table }: { table: Table }) {
  const renameTable = useSchemaStore((state) => state.renameTable);
  const reviewMode = useSchemaStore((state) => state.reviewMode);
  const focusRationale = useSchemaStore((state) => state.focusRationale);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(table.name);

  const commit = () => {
    setEditing(false);
    const next = draft.trim();
    if (next && next !== table.name) {
      renameTable(table.id, next);
    } else {
      setDraft(table.name);
    }
  };

  if (editing) {
    return (
      <input
        className="table-node__title-input nodrag"
        value={draft}
        autoFocus
        onChange={(event) => setDraft(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            commit();
          } else if (event.key === "Escape") {
            setDraft(table.name);
            setEditing(false);
          }
        }}
      />
    );
  }

  return (
    <div
      className="table-node__title"
      title="Double-click to rename"
      onDoubleClick={() => {
        setDraft(table.name);
        setEditing(true);
      }}
    >
      <span className="table-node__title-text">
        {reviewMode ? (
          <ProvenanceMarker origin={tableOrigin(table)} touched={isTouched(table)} />
        ) : null}
        {/* The name needs its own element: `text-overflow` does not apply to a bare text node
            inside a flex container, so an unwrapped name hard-clips mid-glyph. */}
        <span className="table-node__title-name">{table.name}</span>
      </span>
      <span className="table-node__title-meta">
        {reviewMode && table.provenance?.rationale ? (
          <RationaleBadge
            text={table.provenance.rationale.text}
            stale={isStaleRationale(table)}
            onOpen={() => focusRationale({ kind: "table", tableId: table.id })}
          />
        ) : null}
        <span className="table-node__count">{table.fields.length}</span>
      </span>
    </div>
  );
}

function AddFieldRow({ table }: { table: Table }) {
  const addField = useSchemaStore((state) => state.addField);
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState("");

  const commit = () => {
    const next = name.trim();
    if (next) {
      addField(table.id, next);
    }
    setName("");
    setAdding(false);
  };

  if (adding) {
    return (
      <input
        className="table-node__add-input nodrag"
        value={name}
        autoFocus
        placeholder="field name"
        onChange={(event) => setName(event.target.value)}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === "Enter") {
            commit();
          } else if (event.key === "Escape") {
            setName("");
            setAdding(false);
          }
        }}
      />
    );
  }

  return (
    <button type="button" className="table-node__add nodrag" onClick={() => setAdding(true)}>
      + add field
    </button>
  );
}

/**
 * Read-only ghost rendering of a proposed (AI-drafted) table. No store-mutating controls — its
 * fields/ids aren't in the store — and no connection handles, since the proposal isn't editable
 * until accepted. Styled dashed/dimmed via `.table-node--proposed`.
 */
function ProposedTableNode({ table }: { table: Table }) {
  return (
    <div className="table-node table-node--proposed" style={{ width: NODE_WIDTH }}>
      <div className="table-node__title">
        <span>{table.name}</span>
        <span className="table-node__count">{table.fields.length}</span>
      </div>
      {table.fields.map((field) => (
        <div key={field.id} className="table-node__field table-node__field--proposed">
          {/* Non-connectable handles so the ghost relationship edges can still anchor to rows. */}
          <Handle
            type="target"
            position={Position.Left}
            id={field.id}
            isConnectable={false}
            className="field-handle field-handle--target"
          />
          <span className={`table-node__pk${field.pk ? " is-pk" : ""}`} aria-hidden />
          <span className="table-node__field-name">{field.name}</span>
          {field.fk ? <span className="table-node__fk">FK</span> : null}
          <span className="table-node__type">{field.type}</span>
          <Handle
            type="source"
            position={Position.Right}
            id={field.id}
            isConnectable={false}
            className="field-handle field-handle--source"
          />
        </div>
      ))}
    </div>
  );
}

export function TableNode({ data, selected }: NodeProps<TableFlowNode>) {
  const { table, proposed } = data;
  const resizeTable = useSchemaStore((state) => state.resizeTable);

  if (proposed) {
    return <ProposedTableNode table={table} />;
  }

  const width = table.width ?? NODE_WIDTH;

  // Horizontal-only resize: a side handle on each edge. Width persists on the table; height
  // stays content-driven, so we only ever read/write `params.width`.
  const onResize = (_: unknown, params: { width: number }) =>
    resizeTable(table.id, Math.round(params.width));

  return (
    <div className={`table-node${selected ? " is-selected" : ""}`} style={{ width }} data-resizable>
      {selected ? (
        <>
          <NodeResizeControl
            className="table-node__resize table-node__resize--left"
            position="left"
            minWidth={MIN_NODE_WIDTH}
            onResize={onResize}
          />
          <NodeResizeControl
            className="table-node__resize table-node__resize--right"
            position="right"
            minWidth={MIN_NODE_WIDTH}
            onResize={onResize}
          />
        </>
      ) : null}
      <TableTitle table={table} />
      {table.fields.map((field) => (
        <FieldRow key={field.id} table={table} field={field} />
      ))}
      <AddFieldRow table={table} />
    </div>
  );
}
