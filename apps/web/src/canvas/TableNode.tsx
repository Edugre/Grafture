import type { Field, Table } from "@schema-studio/core";
import { Handle, Position } from "@xyflow/react";
import type { Node, NodeProps } from "@xyflow/react";
import { useState } from "react";

import { useSchemaStore } from "../store/index.js";
import { NODE_WIDTH } from "./constants.js";

export type TableNodeData = { table: Table; proposed?: boolean };
export type TableFlowNode = Node<TableNodeData, "table">;

function FieldRow({ table, field }: { table: Table; field: Field }) {
  const togglePk = useSchemaStore((state) => state.togglePk);
  const removeField = useSchemaStore((state) => state.removeField);
  const selectField = useSchemaStore((state) => state.selectField);
  const selectedFieldId = useSchemaStore((state) => state.selection.fieldId);

  const selected = selectedFieldId === field.id;

  return (
    <div
      className={`table-node__field${selected ? " is-selected" : ""}`}
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

      <span className="table-node__field-name">{field.name}</span>
      {field.fk ? <span className="table-node__fk">FK</span> : null}
      <span className="table-node__type">{field.type}</span>
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
      <span>{table.name}</span>
      <span className="table-node__count">{table.fields.length}</span>
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

  if (proposed) {
    return <ProposedTableNode table={table} />;
  }

  return (
    <div className={`table-node${selected ? " is-selected" : ""}`} style={{ width: NODE_WIDTH }}>
      <TableTitle table={table} />
      {table.fields.map((field) => (
        <FieldRow key={field.id} table={table} field={field} />
      ))}
      <AddFieldRow table={table} />
    </div>
  );
}
