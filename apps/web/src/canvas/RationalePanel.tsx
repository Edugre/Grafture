import { useEffect } from "react";

import { useSchemaStore } from "../store/index.js";
import { provenanceLabel, resolveRationale } from "./provenance.js";

const KIND_LABEL: Record<"table" | "field" | "relationship", string> = {
  table: "Table",
  field: "Column",
  relationship: "Relationship",
};

/**
 * The copilot's reasoning for one decision, opened from a rationale badge.
 *
 * Docked to a corner rather than anchored to the node it explains: the canvas pans and zooms, and
 * a popover tracking a moving node either fights the viewport or drifts off-screen. The subject
 * line names what it is about, so the panel does not need to be next to it.
 *
 * It reads the entity through the live schema on every render, so an explanation that goes stale
 * while the panel is open starts saying so instead of continuing to present the state it was
 * opened in — the same rule the badges follow.
 */
export function RationalePanel() {
  const schema = useSchemaStore((state) => state.schema);
  const focus = useSchemaStore((state) => state.rationaleFocus);
  const focusRationale = useSchemaStore((state) => state.focusRationale);

  const resolved = resolveRationale(schema, focus);

  // A focus that no longer resolves — the table was deleted, the rationale dropped — is cleared
  // rather than left dangling, so reopening the same badge later behaves predictably.
  useEffect(() => {
    if (focus && !resolved) {
      focusRationale(null);
    }
  }, [focus, resolved, focusRationale]);

  useEffect(() => {
    if (!resolved) {
      return;
    }
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        focusRationale(null);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [resolved, focusRationale]);

  if (!resolved) {
    return null;
  }

  const { subject, kind, origin, stale, rationale } = resolved;

  return (
    <aside className="rationale-panel" role="complementary" aria-label="Copilot reasoning">
      <div className="rationale-panel__head">
        <span className="rationale-panel__kind">{KIND_LABEL[kind]}</span>
        <span className="rationale-panel__subject" title={subject}>
          {subject}
        </span>
        <button
          type="button"
          className="rationale-panel__close"
          onClick={() => focusRationale(null)}
          title="Close (Esc)"
          aria-label="Close reasoning panel"
        >
          ×
        </button>
      </div>

      {stale ? (
        <p className="rationale-panel__stale" role="status">
          Edited since this was written — the reasoning below may no longer describe it.
        </p>
      ) : null}

      <p className="rationale-panel__text">{rationale.text}</p>

      {rationale.evidence.length > 0 ? (
        <div className="rationale-panel__evidence">
          <span className="rationale-panel__evidence-label">Evidence</span>
          <ul>
            {rationale.evidence.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </div>
      ) : null}

      <p className="rationale-panel__meta">{provenanceLabel(origin)}</p>
    </aside>
  );
}
