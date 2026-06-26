import { useViewport } from "@xyflow/react";

import type { PreviewAnchor, SuggestionPreview } from "./suggestionPreview.js";
import "./PreviewOverlay.css";

/**
 * Draws the active suggestion's preview on top of the canvas (handoff:
 * design_handoff_active_suggestion_preview): a scrim that dims the schema, a dashed accent
 * "ghost" edge for the proposed relationship, glowing rings on the involved column rows, and a
 * caption pill. Geometry arrives in flow coordinates; we project it to screen space with the live
 * viewport so it tracks pan/zoom. The whole layer is non-interactive (`pointer-events: none`).
 */
export function PreviewOverlay({ preview }: { preview: SuggestionPreview }) {
  const { x, y, zoom } = useViewport();

  const projectX = (fx: number) => fx * zoom + x;
  const projectY = (fy: number) => fy * zoom + y;

  const edgePath = preview.edge ? buildEdgePath(preview.edge.from, preview.edge.to) : null;

  return (
    <div className={`preview-overlay preview-overlay--${preview.tone}`} aria-hidden>
      <div className="preview-scrim" />

      {edgePath ? (
        <svg className="preview-edge">
          <path className="preview-edge__glow" d={edgePath} />
          <path className="preview-edge__line" d={edgePath} />
        </svg>
      ) : null}

      {preview.rings.map((ring, index) => (
        <div
          key={index}
          className="preview-ring"
          style={{
            left: projectX(ring.x),
            top: projectY(ring.y),
            width: ring.w * zoom,
            height: ring.h * zoom,
          }}
        />
      ))}

      <div className="preview-caption">
        <span className="preview-caption__badge">{preview.caption.badge}</span>
        <span className="preview-caption__text">
          <span className="preview-caption__title">{preview.caption.title}</span>
          <span className="preview-caption__stat">{preview.caption.stat}</span>
        </span>
      </div>
    </div>
  );

  function buildEdgePath(from: PreviewAnchor, to: PreviewAnchor): string {
    const ax = projectX(from.x);
    const ay = projectY(from.y);
    const bx = projectX(to.x);
    const by = projectY(to.y);
    const offset = Math.max(40 * zoom, Math.abs(bx - ax) * 0.5);
    const c1 = from.side === "right" ? ax + offset : ax - offset;
    const c2 = to.side === "right" ? bx + offset : bx - offset;
    return `M${ax},${ay} C${c1},${ay} ${c2},${by} ${bx},${by}`;
  }
}
