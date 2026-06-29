import type { Cardinality } from "@schema-studio/core";
import { BaseEdge, EdgeLabelRenderer, getSmoothStepPath } from "@xyflow/react";
import type { Edge, EdgeProps } from "@xyflow/react";

import { useSchemaStore } from "../store/index.js";

export type RelationshipEdgeData = {
  relationshipId: string;
  cardinality: Cardinality;
  /** Part of an AI-drafted proposal (ghost) — rendered dashed and non-interactive. */
  proposed?: boolean;
};
export type RelationshipFlowEdge = Edge<RelationshipEdgeData, "relationship">;

/** Clicking the label cycles 1:N → 1:1 → N:M, routed through the store (undoable). */
const NEXT: Record<Cardinality, Cardinality> = {
  "1:N": "1:1",
  "1:1": "N:M",
  "N:M": "1:N",
};

export function RelationshipEdge({
  id,
  sourceX,
  sourceY,
  targetX,
  targetY,
  sourcePosition,
  targetPosition,
  data,
  markerEnd,
  selected,
}: EdgeProps<RelationshipFlowEdge>) {
  const setCardinality = useSchemaStore((state) => state.setCardinality);

  const [edgePath, labelX, labelY] = getSmoothStepPath({
    sourceX,
    sourceY,
    targetX,
    targetY,
    sourcePosition,
    targetPosition,
  });

  const cardinality = data?.cardinality ?? "1:N";
  const relationshipId = data?.relationshipId ?? id;
  const proposed = data?.proposed ?? false;

  // Proposed (ghost) edges are dashed, tinted, and don't carry the arrow marker.
  const proposedStyle = { stroke: "var(--edge-proposed)", strokeDasharray: "6 4" };

  return (
    <>
      <BaseEdge
        id={id}
        path={edgePath}
        {...(proposed ? { style: proposedStyle } : markerEnd ? { markerEnd } : {})}
      />
      <EdgeLabelRenderer>
        {proposed ? (
          <span
            className="relationship-label relationship-label--proposed nodrag nopan"
            style={{ transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)` }}
          >
            {cardinality}
          </span>
        ) : (
          <button
            type="button"
            className={`relationship-label nodrag nopan${selected ? " is-selected" : ""}`}
            style={{
              transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)`,
            }}
            title="Click to change cardinality"
            onClick={() => setCardinality(relationshipId, NEXT[cardinality])}
          >
            {cardinality}
          </button>
        )}
      </EdgeLabelRenderer>
    </>
  );
}
