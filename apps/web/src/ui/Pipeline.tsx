import { CheckIcon, XIcon } from "./icons.js";
import "./Pipeline.css";

/**
 * A single phase of work. Only four states exist and each one maps to work that actually
 * happened — there is no "in between" and no synthetic percentage. `detail` is the truthful
 * sub-line (real counts, real error text); leave it out rather than invent one.
 */
export type StepState = "pending" | "active" | "done" | "failed";

export type PipelineStep = {
  id: string;
  label: string;
  detail?: string | undefined;
  state: StepState;
};

/**
 * The shared loading visual: a column of step dots joined by a 2px rail that turns accent behind
 * each step that has finished.
 *
 * The rail is drawn per step rather than as one absolutely-positioned bar, so it always ends at
 * the last dot no matter how tall a step's detail text grows — a multi-line parse error used to
 * drag a single full-height rail well past the final dot.
 *
 * Nothing here is driven by a timer. A filled segment means that step genuinely finished; a step
 * still running shows a pulsing dot and nothing more, because "still working" is the only honest
 * thing we know about it.
 *
 * Used by both of the app's loading moments — creating a project (`CreateProgress`) and parsing
 * dropped files in the sources panel (`ParsingOverlay`) — so the two read as one language.
 */
export function Pipeline({ steps, className }: { steps: PipelineStep[]; className?: string }) {
  return (
    <ol className={`pipeline${className ? ` ${className}` : ""}`}>
      {steps.map((step) => (
        <li className="pipeline__step" key={step.id} data-state={step.state}>
          <span className="pipeline__dot" aria-hidden>
            {step.state === "done" ? <CheckIcon size={11} /> : null}
            {step.state === "failed" ? <XIcon size={11} /> : null}
          </span>
          <span className="pipeline__text">
            <span className="pipeline__label">{step.label}</span>
            {step.detail ? <span className="pipeline__detail">{step.detail}</span> : null}
          </span>
        </li>
      ))}
    </ol>
  );
}
