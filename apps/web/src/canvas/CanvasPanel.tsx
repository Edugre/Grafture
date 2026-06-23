import {
  Background,
  Controls,
  MarkerType,
  MiniMap,
  ReactFlow,
  useEdgesState,
  useNodesState,
} from "@xyflow/react";
import type { Connection, EdgeChange, NodeChange, ReactFlowInstance } from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { useCallback, useEffect, useRef } from "react";

import { useSchemaStore } from "../store/index.js";
import { RelationshipEdge } from "./RelationshipEdge.js";
import type { RelationshipFlowEdge } from "./RelationshipEdge.js";
import { TableNode } from "./TableNode.js";
import type { TableFlowNode } from "./TableNode.js";
import { layoutSchema } from "./layout.js";

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

export function CanvasPanel() {
  const tables = useSchemaStore((state) => state.schema.tables);
  const relationships = useSchemaStore((state) => state.schema.relationships);

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

  // The store owns structure + positions; ReactFlow's local arrays carry only the
  // ephemeral selection/measured-size state, which we preserve on each re-derive.
  useEffect(() => {
    setNodes((prev) =>
      tables.map((table) => {
        const existing = prev.find((node) => node.id === table.id);
        return {
          id: table.id,
          type: "table" as const,
          position: { x: table.x, y: table.y },
          data: { table },
          selected: existing?.selected ?? false,
        };
      }),
    );
  }, [tables, setNodes]);

  useEffect(() => {
    setEdges((prev) =>
      relationships.map((relationship) => {
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
      }),
    );
  }, [relationships, setEdges]);

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

  return (
    <section className="panel canvas-panel">
      <header className="panel-header canvas-toolbar">
        <span>Canvas</span>
        <div className="canvas-toolbar__actions">
          <button type="button" onClick={onAddTable}>
            + Table
          </button>
          <button type="button" onClick={() => void onAutoArrange()} disabled={tables.length === 0}>
            Auto-arrange
          </button>
          <button type="button" onClick={undo} disabled={!canUndo}>
            Undo
          </button>
          <button type="button" onClick={redo} disabled={!canRedo}>
            Redo
          </button>
        </div>
      </header>
      <div className="panel-body">
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
          onInit={(instance) => {
            instanceRef.current = instance;
          }}
          deleteKeyCode={["Delete", "Backspace"]}
          fitView
        >
          <Background />
          <Controls />
          <MiniMap pannable zoomable />
        </ReactFlow>
      </div>
    </section>
  );
}
