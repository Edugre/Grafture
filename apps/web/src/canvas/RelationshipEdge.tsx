import type { Cardinality, Provenance } from "@grafture/core";
import { BaseEdge, EdgeLabelRenderer, getSmoothStepPath } from "@xyflow/react";
import type { Edge, EdgeProps } from "@xyflow/react";

import { useSchemaStore } from "../store/index.js";
import { isStaleRationale, originOf, provenanceLabel } from "./provenance.js";

export type RelationshipEdgeData = {
  relationshipId: string;
  cardinality: Cardinality;
  /** Part of an AI-drafted proposal (ghost) — rendered dashed and non-interactive. */
  proposed?: boolean;
  provenance?: Provenance | undefined;
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
  const reviewMode = useSchemaStore((state) => state.reviewMode);

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

  // Edge labels are tight, so provenance rides the existing cardinality chip rather than adding a
  // second floating element: `data-origin` tints its border, and the rationale extends the title
  // the chip already carries.
  const entity = { provenance: data?.provenance };
  const rationale = data?.provenance?.rationale;
  const showProvenance = reviewMode && !proposed;
  const stale = isStaleRationale(entity);
  const labelTitle = showProvenance
    ? [
        provenanceLabel(originOf(entity), { touched: entity.provenance?.touched ?? false }),
        rationale ? `${stale ? "Why (edited since)" : "Why"}: ${rationale.text}` : null,
        "Click to change cardinality",
      ]
        .filter(Boolean)
        .join(" — ")
    : "Click to change cardinality";

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
            className={`relationship-label nodrag nopan${selected ? " is-selected" : ""}${
              showProvenance ? " is-reviewed" : ""
            }${showProvenance && stale ? " is-stale" : ""}`}
            {...(showProvenance ? { "data-origin": originOf(entity) } : {})}
            style={{
              transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)`,
            }}
            title={labelTitle}
            aria-label={labelTitle}
            onClick={() => setCardinality(relationshipId, NEXT[cardinality])}
          >
            {cardinality}
            {showProvenance && rationale ? (
              <span className="relationship-label__why" aria-hidden>
                {stale ? "?" : "i"}
              </span>
            ) : null}
          </button>
        )}
      </EdgeLabelRenderer>
    </>
  );
}
