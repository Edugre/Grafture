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
  const focusRationale = useSchemaStore((state) => state.focusRationale);

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

  // Edge labels are tight, so origin rides the existing cardinality chip's border rather than
  // adding a third floating element. The reasoning itself lives on the badge beside it.
  const entity = { provenance: data?.provenance };
  const rationale = data?.provenance?.rationale;
  const showProvenance = reviewMode && !proposed;
  const stale = isStaleRationale(entity);
  const labelTitle = showProvenance
    ? `${provenanceLabel(originOf(entity), {
        touched: entity.provenance?.touched ?? false,
      })} — Click to change cardinality`
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
            // Every live cardinality chip is a candidate anchor; the tour's `querySelector` takes
            // whichever one the canvas painted first, which is a real edge either way.
            data-tour="relationship"
            style={{
              transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)`,
            }}
            title={labelTitle}
            aria-label={labelTitle}
            onClick={() => setCardinality(relationshipId, NEXT[cardinality])}
          >
            {cardinality}
          </button>
        )}
        {showProvenance && rationale ? (
          // A sibling of the cardinality chip, not a child: the chip is itself a button (it cycles
          // cardinality), and a button inside a button is invalid and unreachable by keyboard.
          // Offset just past the chip so the two read as one control group.
          <button
            type="button"
            className={`rationale-badge rationale-badge--edge nodrag nopan${
              stale ? " is-stale" : ""
            }`}
            style={{
              transform: `translate(-50%, -50%) translate(${labelX + 26}px, ${labelY}px)`,
            }}
            title={stale ? `Why (edited since): ${rationale.text}` : `Why: ${rationale.text}`}
            aria-label={stale ? `Why (edited since): ${rationale.text}` : `Why: ${rationale.text}`}
            onClick={() => focusRationale({ kind: "relationship", relationshipId })}
          >
            {stale ? "?" : "i"}
          </button>
        ) : null}
      </EdgeLabelRenderer>
    </>
  );
}
