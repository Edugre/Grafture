import { Pipeline, type PipelineStep } from "../ui/Pipeline.js";
import { SparkleIcon } from "../ui/icons.js";
import "./CreateProgress.css";

export type { PipelineStep as CreateStep } from "../ui/Pipeline.js";

/** The one-sentence version screen readers get, so they aren't read the whole list on every tick. */
function announce(steps: PipelineStep[], error: string | undefined): string {
  if (error !== undefined) {
    return `Project creation failed. ${error}`;
  }
  const active = steps.find((step) => step.state === "active");
  if (active) {
    return `${active.label}…`;
  }
  return steps.every((step) => step.state === "done") ? "Project created." : "";
}

/**
 * The create-project progress body (Hallmark component: modal loading state). Takes over the
 * New Project card once "Create project" is pressed, replacing the form in place. The rail itself
 * is {@link Pipeline}, shared with the sources panel's parsing overlay.
 *
 * Deliberately absent: any claim about the AI schema draft. That request is issued by the Copilot
 * after the canvas mounts, so this component can't observe it. When auto-draft is on we say so in
 * `note` instead of animating a phase we aren't awaiting.
 */
export function CreateProgress({
  title,
  steps,
  note,
  error,
  onCancel,
  onRetry,
}: {
  /** The project being created — the user's own title, or a neutral fallback. */
  title: string;
  steps: PipelineStep[];
  /** Truthful aside shown under the rail (e.g. what the Copilot will do on arrival). */
  note?: string | undefined;
  /** Set when a step failed; swaps the footer to Back / Try again. */
  error?: string | undefined;
  onCancel: () => void;
  onRetry: () => void;
}) {
  const failed = error !== undefined;

  return (
    <div className="cp">
      <p className="cp__title">
        {failed ? "Couldn’t create " : "Creating "}
        <span className="cp__title-name">{title}</span>
      </p>

      <Pipeline steps={steps} className="cp__pipeline" />

      {failed ? (
        <p className="cp__error">{error}</p>
      ) : note ? (
        <p className="cp__note">
          <SparkleIcon size={12} />
          {note}
        </p>
      ) : null}

      <div className="cp__actions">
        {failed ? (
          <>
            <button type="button" className="npm-btn npm-btn--ghost" onClick={onCancel}>
              Back to form
            </button>
            <button type="button" className="npm-btn npm-btn--primary" onClick={onRetry}>
              Try again
            </button>
          </>
        ) : (
          // Disabled rather than hidden: the control keeps its position across the whole
          // sequence, and the save is a local IndexedDB write we can't safely interrupt.
          <button type="button" className="npm-btn npm-btn--ghost" disabled>
            Cancel
          </button>
        )}
      </div>

      <span className="cp__sr" role="status" aria-live="polite">
        {announce(steps, error)}
      </span>
    </div>
  );
}
