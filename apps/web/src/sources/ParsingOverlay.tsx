import { Pipeline, type PipelineStep } from "../ui/Pipeline.js";
import "./ParsingOverlay.css";

/** The screen-reader sentence — the visual list is redundant to announce in full on every tick. */
function announce(steps: PipelineStep[], settled: boolean): string {
  if (!settled) {
    const active = steps.find((step) => step.state === "active");
    return active ? `Parsing ${active.label}…` : "";
  }
  const failed = steps.filter((step) => step.state === "failed").length;
  return failed === 0
    ? "All files parsed."
    : `${failed} of ${steps.length} files couldn’t be parsed. Review the list, then dismiss.`;
}

/**
 * The sources panel's parsing surface (Hallmark component: panel loading state).
 *
 * Covers the panel body while dropped files are read, using the same {@link Pipeline} rail as the
 * New Project modal so the app has one loading language rather than two. One step per file, each
 * carrying its real outcome — column counts on success, the parser's reason on failure.
 *
 * It is modal in behaviour: while parsing, it blocks the panel underneath, because every control
 * down there (add, remove, build table) acts on a source list that is actively changing.
 *
 * Dismissal is asymmetric on purpose. If everything parsed, the overlay closes itself — the new
 * source cards appearing behind it *are* the confirmation, and a "3 files parsed" banner you have
 * to dismiss is noise. If anything failed, it stays up until the user dismisses it, because a
 * failure that scrolls past unread is a failure that gets reported as a missing file later.
 */
export function ParsingOverlay({
  steps,
  settled,
  onDismiss,
}: {
  steps: PipelineStep[];
  /** True once every file has settled; flips the footer from a live count to the dismiss action. */
  settled: boolean;
  onDismiss: () => void;
}) {
  const failed = steps.filter((step) => step.state === "failed").length;
  const done = steps.filter((step) => step.state === "done").length;

  return (
    <div className="parsing-overlay">
      <div
        className="parsing-overlay__card"
        role="dialog"
        aria-modal="true"
        aria-label="Parsing files"
      >
        <p className="parsing-overlay__title">
          {settled
            ? `${failed} of ${steps.length} ${steps.length === 1 ? "file" : "files"} couldn’t be read`
            : "Reading files"}
          <span className="parsing-overlay__count">
            {settled ? `${done} added` : `${done} of ${steps.length}`}
          </span>
        </p>

        <Pipeline steps={steps} className="parsing-overlay__pipeline" />

        {settled ? (
          <button type="button" className="parsing-overlay__dismiss" onClick={onDismiss} autoFocus>
            Dismiss
          </button>
        ) : (
          <p className="parsing-overlay__foot">Parsed in your browser — nothing is uploaded.</p>
        )}

        <span className="parsing-overlay__sr" role="status" aria-live="polite">
          {announce(steps, settled)}
        </span>
      </div>
    </div>
  );
}
