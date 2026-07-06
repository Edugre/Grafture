import {
  Background,
  BackgroundVariant,
  MarkerType,
  MiniMap,
  ReactFlow,
  useEdgesState,
  useNodesState,
} from "@xyflow/react";
import type { Connection, EdgeChange, NodeChange, ReactFlowInstance } from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { useSchemaStore } from "../store/index.js";
import { useSuggestions } from "../suggest/index.js";
import {
  ChevronLeftIcon,
  FitViewIcon,
  LockIcon,
  MaximizeIcon,
  MinimizeIcon,
  MinusIcon,
  PlusIcon,
  RedoIcon,
  UndoIcon,
  UnlockIcon,
} from "../ui/icons.js";
import { PreviewOverlay } from "./PreviewOverlay.js";
import { registerArrangeHandler } from "./arrangeBridge.js";
import { RelationshipEdge } from "./RelationshipEdge.js";
import type { RelationshipFlowEdge } from "./RelationshipEdge.js";
import { TableNode } from "./TableNode.js";
import type { TableFlowNode } from "./TableNode.js";
import { layoutSchema } from "./layout.js";
import { buildSuggestionPreview } from "./suggestionPreview.js";

const nodeTypes = { table: TableNode };
const edgeTypes = { relationship: RelationshipEdge };

const defaultEdgeOptions = {
  type: "relationship",
  markerEnd: { type: MarkerType.ArrowClosed },
};

function uniqueTableName(existing: ReadonlySet<string>): string {
  let n = existing.size + 1;
  let name = `table_${n}`;
  while (existing.has(name.toLowerCase())) {
    n += 1;
    name = `table_${n}`;
  }
  return name;
}

export function CanvasPanel({
  activeSuggestionId,
  onBack,
}: {
  activeSuggestionId: string | null;
  onBack: () => void;
}) {
  const schema = useSchemaStore((state) => state.schema);
  const tables = schema.tables;
  const relationships = schema.relationships;
  const selectedTableId = useSchemaStore((state) => state.selection.tableId);
  const schemaDraft = useSchemaStore((state) => state.draft);
  const acceptDraft = useSchemaStore((state) => state.acceptDraft);
  const discardDraft = useSchemaStore((state) => state.discardDraft);
  const { open: openSuggestions } = useSuggestions();

  // Resolve the active suggestion to canvas geometry. Null when nothing is active or the
  // suggestion's tables/fields aren't on the canvas (e.g. a join whose tables aren't built yet).
  const preview = useMemo(() => {
    if (!activeSuggestionId) {
      return null;
    }
    const item = openSuggestions.find((suggestion) => suggestion.id === activeSuggestionId);
    return item ? buildSuggestionPreview(item, schema) : null;
  }, [activeSuggestionId, openSuggestions, schema]);

  // Count of proposed (ghost) tables not yet in the live schema — drives the Accept/Discard bar.
  const draftTableCount = useMemo(() => {
    if (!schemaDraft) {
      return 0;
    }
    const liveIds = new Set(tables.map((table) => table.id));
    return schemaDraft.tables.filter((table) => !liveIds.has(table.id)).length;
  }, [schemaDraft, tables]);

  const selectTable = useSchemaStore((state) => state.selectTable);
  const moveTable = useSchemaStore((state) => state.moveTable);
  const moveTables = useSchemaStore((state) => state.moveTables);
  const removeTable = useSchemaStore((state) => state.removeTable);
  const addTable = useSchemaStore((state) => state.addTable);
  const addRelationship = useSchemaStore((state) => state.addRelationship);
  const removeRelationship = useSchemaStore((state) => state.removeRelationship);
  const undo = useSchemaStore((state) => state.undo);
  const redo = useSchemaStore((state) => state.redo);
  const canUndo = useSchemaStore((state) => state.canUndo());
  const canRedo = useSchemaStore((state) => state.canRedo());

  const [nodes, setNodes, onNodesChange] = useNodesState<TableFlowNode>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<RelationshipFlowEdge>([]);

  const instanceRef = useRef<ReactFlowInstance<TableFlowNode, RelationshipFlowEdge> | null>(null);
  // The canvas section, used as the Fullscreen API target.
  const containerRef = useRef<HTMLElement>(null);
  // Interactivity lock: when on, nodes/edges can't be dragged, selected, or connected.
  const [locked, setLocked] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);
  // Surfaced here because the chat error acceptDraft also writes can sit in a hidden tab —
  // the user who clicked Accept on the canvas must see why the draft vanished.
  const [draftError, setDraftError] = useState<string | null>(null);

  // A fresh draft supersedes any stale failure message.
  useEffect(() => {
    if (draftTableCount > 0) {
      setDraftError(null);
    }
  }, [draftTableCount]);

  // Keep the fullscreen icon in sync whether the user toggles via the button or Esc.
  useEffect(() => {
    const onChange = () => setIsFullscreen(document.fullscreenElement === containerRef.current);
    document.addEventListener("fullscreenchange", onChange);
    return () => document.removeEventListener("fullscreenchange", onChange);
  }, []);

  const toggleFullscreen = useCallback(() => {
    if (document.fullscreenElement) {
      void document.exitFullscreen();
    } else {
      void containerRef.current?.requestFullscreen();
    }
  }, []);

  const zoomIn = useCallback(() => instanceRef.current?.zoomIn({ duration: 200 }), []);
  const zoomOut = useCallback(() => instanceRef.current?.zoomOut({ duration: 200 }), []);
  const fitView = useCallback(() => instanceRef.current?.fitView({ duration: 300 }), []);

  // The store owns structure + positions; ReactFlow's local arrays carry only the
  // ephemeral selection/measured-size state, which we preserve on each re-derive.
  useEffect(() => {
    const liveIds = new Set(tables.map((table) => table.id));
    const live = tables.map((table) => ({
      id: table.id,
      type: "table" as const,
      position: { x: table.x, y: table.y },
      data: { table },
      // The active table (store selection) is the canvas's selected node, so picking it here
      // or from the Sources panel highlights the same card.
      selected: table.id === selectedTableId,
    }));
    // Ghost nodes for an AI-drafted proposal: new tables not yet in the live schema. Locked down
    // (non-draggable/deletable/selectable) so they can't write back to the store before Accept.
    const ghosts = (schemaDraft?.tables ?? [])
      .filter((table) => !liveIds.has(table.id))
      .map((table) => ({
        id: table.id,
        type: "table" as const,
        position: { x: table.x, y: table.y },
        data: { table, proposed: true },
        selected: false,
        draggable: false,
        deletable: false,
        selectable: false,
      }));
    setNodes([...live, ...ghosts]);
  }, [tables, selectedTableId, schemaDraft, setNodes]);

  useEffect(() => {
    const liveRelIds = new Set(relationships.map((relationship) => relationship.id));
    setEdges((prev) => {
      const live = relationships.map((relationship) => {
        const existing = prev.find((edge) => edge.id === relationship.id);
        return {
          id: relationship.id,
          type: "relationship" as const,
          source: relationship.fromTable,
          target: relationship.toTable,
          sourceHandle: relationship.fromField,
          targetHandle: relationship.toField,
          data: {
            relationshipId: relationship.id,
            cardinality: relationship.cardinality,
          },
          selected: existing?.selected ?? false,
        };
      });
      // Ghost edges for the AI-drafted proposal (dashed, non-interactive until Accept).
      const ghosts = (schemaDraft?.relationships ?? [])
        .filter((relationship) => !liveRelIds.has(relationship.id))
        .map((relationship) => ({
          id: relationship.id,
          type: "relationship" as const,
          source: relationship.fromTable,
          target: relationship.toTable,
          sourceHandle: relationship.fromField,
          targetHandle: relationship.toField,
          data: {
            relationshipId: relationship.id,
            cardinality: relationship.cardinality,
            proposed: true,
          },
          selected: false,
          deletable: false,
          selectable: false,
        }));
      return [...live, ...ghosts];
    });
  }, [relationships, schemaDraft, setEdges]);

  const handleNodesChange = useCallback(
    (changes: NodeChange<TableFlowNode>[]) => {
      onNodesChange(changes);
      for (const change of changes) {
        if (change.type === "position" && change.position) {
          moveTable(change.id, change.position.x, change.position.y);
        } else if (change.type === "remove") {
          removeTable(change.id);
        }
      }
    },
    [onNodesChange, moveTable, removeTable],
  );

  const handleEdgesChange = useCallback(
    (changes: EdgeChange<RelationshipFlowEdge>[]) => {
      onEdgesChange(changes);
      for (const change of changes) {
        if (change.type === "remove") {
          removeRelationship(change.id);
        }
      }
    },
    [onEdgesChange, removeRelationship],
  );

  const onConnect = useCallback(
    (connection: Connection) => {
      if (
        connection.source &&
        connection.target &&
        connection.sourceHandle &&
        connection.targetHandle
      ) {
        addRelationship(
          connection.source,
          connection.sourceHandle,
          connection.target,
          connection.targetHandle,
        );
      }
    },
    [addRelationship],
  );

  const onAddTable = useCallback(() => {
    const names = new Set(tables.map((table) => table.name.toLowerCase()));
    addTable(uniqueTableName(names));
  }, [tables, addTable]);

  const onAutoArrange = useCallback(async () => {
    const positions = await layoutSchema({ tables, relationships });
    if (positions.length > 0) {
      moveTables(positions);
    }
    requestAnimationFrame(() => instanceRef.current?.fitView({ duration: 300 }));
  }, [tables, relationships, moveTables]);

  // Expose auto-arrange to the top bar's "Auto-arrange" button.
  useEffect(() => registerArrangeHandler(() => void onAutoArrange()), [onAutoArrange]);

  const tableCount = tables.length;
  const relationshipCount = relationships.length;

  return (
    <section className="panel canvas-panel" ref={containerRef}>
      <div className="panel-body">
        <div className="canvas-status">
          <button type="button" className="canvas-back" onClick={onBack} title="Back to projects">
            <ChevronLeftIcon size={15} />
            Projects
          </button>
          <div className="canvas-chip">
            <span className="canvas-chip__label">Inferred schema</span>
            <span className="canvas-chip__count">
              {tableCount} {tableCount === 1 ? "table" : "tables"} · {relationshipCount}{" "}
              {relationshipCount === 1 ? "relationship" : "relationships"}
            </span>
          </div>
          {preview ? (
            <span className="canvas-preview-pill">
              <span className="canvas-preview-pill__dot" aria-hidden />
              Previewing — not yet applied
            </span>
          ) : null}
          {draftTableCount > 0 ? (
            <div className="canvas-draft-bar">
              <span className="canvas-draft-bar__label">
                <span className="canvas-draft-bar__dot" aria-hidden />
                AI drafted {draftTableCount} {draftTableCount === 1 ? "table" : "tables"}
              </span>
              <button
                type="button"
                className="canvas-draft-bar__btn canvas-draft-bar__btn--ghost"
                onClick={discardDraft}
              >
                Discard
              </button>
              <button
                type="button"
                className="canvas-draft-bar__btn canvas-draft-bar__btn--primary"
                onClick={() => {
                  const result = acceptDraft();
                  setDraftError(result.ok ? null : result.error);
                }}
              >
                Accept
              </button>
            </div>
          ) : null}
          {draftError ? (
            <div className="canvas-draft-bar canvas-draft-bar--error" role="alert">
              <span className="canvas-draft-bar__label">{draftError}</span>
            </div>
          ) : null}
        </div>
        <div className="canvas-tools">
          <button
            type="button"
            className="canvas-tools__btn"
            onClick={onAddTable}
            title="Add table"
          >
            <PlusIcon size={15} />
            <span>Table</span>
          </button>
          <span className="canvas-tools__divider" />
          <button
            type="button"
            className="canvas-tools__icon"
            onClick={undo}
            disabled={!canUndo}
            title="Undo"
            aria-label="Undo"
          >
            <UndoIcon size={15} />
          </button>
          <button
            type="button"
            className="canvas-tools__icon"
            onClick={redo}
            disabled={!canRedo}
            title="Redo"
            aria-label="Redo"
          >
            <RedoIcon size={15} />
          </button>
          {tableCount > 0 ? (
            <>
              <span className="canvas-tools__divider" />
              <label className="canvas-tools__active">
                Active table
                <select
                  className="canvas-tools__select"
                  value={selectedTableId ?? ""}
                  onChange={(event) => selectTable(event.target.value || undefined)}
                >
                  <option value="">Select…</option>
                  {tables.map((table) => (
                    <option key={table.id} value={table.id}>
                      {table.name}
                    </option>
                  ))}
                </select>
              </label>
            </>
          ) : null}
        </div>
        <ReactFlow
          className="schema-canvas"
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          edgeTypes={edgeTypes}
          defaultEdgeOptions={defaultEdgeOptions}
          onNodesChange={handleNodesChange}
          onEdgesChange={handleEdgesChange}
          onConnect={onConnect}
          onNodeClick={(_, node) => selectTable(node.id)}
          onPaneClick={() => selectTable(undefined)}
          onInit={(instance) => {
            instanceRef.current = instance;
          }}
          deleteKeyCode={["Delete", "Backspace"]}
          nodesDraggable={!locked}
          nodesConnectable={!locked}
          elementsSelectable={!locked}
          fitView
        >
          <Background variant={BackgroundVariant.Dots} gap={24} size={1} />
          <MiniMap pannable zoomable />
          {preview ? <PreviewOverlay preview={preview} /> : null}
          <div className="canvas-controls">
            <button
              type="button"
              className="canvas-controls__btn"
              onClick={zoomIn}
              title="Zoom in"
              aria-label="Zoom in"
            >
              <PlusIcon size={15} />
            </button>
            <button
              type="button"
              className="canvas-controls__btn"
              onClick={zoomOut}
              title="Zoom out"
              aria-label="Zoom out"
            >
              <MinusIcon size={15} />
            </button>
            <button
              type="button"
              className="canvas-controls__btn"
              onClick={fitView}
              title="Fit view"
              aria-label="Fit view"
            >
              <FitViewIcon size={15} />
            </button>
            <button
              type="button"
              className="canvas-controls__btn"
              onClick={toggleFullscreen}
              title={isFullscreen ? "Exit fullscreen" : "Fullscreen"}
              aria-label={isFullscreen ? "Exit fullscreen" : "Fullscreen"}
            >
              {isFullscreen ? <MinimizeIcon size={15} /> : <MaximizeIcon size={15} />}
            </button>
            <button
              type="button"
              className={`canvas-controls__btn${locked ? " is-active" : ""}`}
              onClick={() => setLocked((value) => !value)}
              title={locked ? "Unlock canvas" : "Lock canvas"}
              aria-label={locked ? "Unlock canvas" : "Lock canvas"}
              aria-pressed={locked}
            >
              {locked ? <LockIcon size={15} /> : <UnlockIcon size={15} />}
            </button>
          </div>
        </ReactFlow>
      </div>
    </section>
  );
}
