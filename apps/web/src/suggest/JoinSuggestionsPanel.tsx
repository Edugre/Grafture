import { useMemo, useState } from "react";

import { useSchemaStore } from "../store/index.js";
import {
  buildApplyPlan,
  buildJoinSuggestions,
  buildKeySuggestions,
  buildSetPkPlan,
  buildSetTypePlan,
  buildTypeSuggestions,
  type KeySuggestion,
  type TypeSuggestion,
} from "./joinSuggestions.js";
import "./JoinSuggestions.css";

/**
 * SS-9 — reviewable content-aware suggestions derived from the core detectors. Everything here
 * runs locally over the parsed sources (no AI, no network) and applies through the validated
 * store path (`runActions`):
 *  - **Suggested joins** — cross-source join keys by value overlap, with format-mismatch
 *    warnings and an inferred relationship grain (1:1 / 1:N / N:M).
 *  - **Suggested keys** — columns the data shows are unique and non-null (primary-key candidates).
 *  - **Suggested types** — canvas fields whose type disagrees with their source column's data.
 */
export function JoinSuggestions() {
  const sources = useSchemaStore((state) => state.sources);
  const schema = useSchemaStore((state) => state.schema);
  const runActions = useSchemaStore((state) => state.runActions);
  const selectTable = useSchemaStore((state) => state.selectTable);

  const [message, setMessage] = useState<{ kind: "info" | "error"; text: string } | null>(null);

  const joinSuggestions = useMemo(
    () => buildJoinSuggestions(sources, schema).filter((suggestion) => !suggestion.alreadyLinked),
    [sources, schema],
  );

  const keySuggestions = useMemo(() => buildKeySuggestions(sources, schema), [sources, schema]);

  const typeSuggestions = useMemo(() => buildTypeSuggestions(sources, schema), [sources, schema]);

  if (joinSuggestions.length === 0 && keySuggestions.length === 0 && typeSuggestions.length === 0) {
    return null;
  }

  const handleApplyJoin = (candidate: (typeof joinSuggestions)[number]["candidate"]) => {
    const plan = buildApplyPlan(sources, schema, candidate);
    if (!plan.ok) {
      setMessage({ kind: "error", text: plan.error });
      return;
    }

    const { applied, rejected } = runActions(plan.actions);
    if (rejected.length > 0) {
      setMessage({ kind: "error", text: rejected.map((entry) => entry.reason).join("; ") });
      return;
    }

    const linkedTableId = applied.at(-1)?.tableIds[0];
    if (linkedTableId) {
      selectTable(linkedTableId);
    }

    const built = plan.builtTables.length > 0 ? ` (built ${plan.builtTables.join(", ")})` : "";
    setMessage({ kind: "info", text: `Linked on ${candidate.left.field}${built}.` });
  };

  const handleApplyKey = (suggestion: KeySuggestion) => {
    const { actions } = buildSetPkPlan(suggestion);
    const { applied, rejected } = runActions(actions);
    if (rejected.length > 0) {
      setMessage({ kind: "error", text: rejected.map((entry) => entry.reason).join("; ") });
      return;
    }

    const tableId = applied.at(-1)?.tableIds[0];
    if (tableId) {
      selectTable(tableId);
    }
    setMessage({
      kind: "info",
      text: `Set ${suggestion.candidate.field} as the primary key of ${suggestion.tableName}.`,
    });
  };

  const handleApplyType = (suggestion: TypeSuggestion) => {
    const { actions } = buildSetTypePlan(suggestion);
    const { applied, rejected } = runActions(actions);
    if (rejected.length > 0) {
      setMessage({ kind: "error", text: rejected.map((entry) => entry.reason).join("; ") });
      return;
    }

    const tableId = applied.at(-1)?.tableIds[0];
    if (tableId) {
      selectTable(tableId);
    }
    setMessage({
      kind: "info",
      text: `Set ${suggestion.field} to ${suggestion.suggestedType}.`,
    });
  };

  return (
    <section className="join-suggestions" aria-label="Modeling suggestions">
      {message ? (
        <p className={`join-suggestions__message join-suggestions__message--${message.kind}`}>
          {message.text}
        </p>
      ) : null}

      {joinSuggestions.length > 0 ? (
        <>
          <header className="join-suggestions__header">
            <span>Suggested joins</span>
            <span className="join-suggestions__subtle">from your data, not column names</span>
          </header>

          <ul className="join-suggestions__list">
            {joinSuggestions.map((suggestion) => (
              <li key={suggestion.id} className="join-suggestions__item">
                <div className="join-suggestions__pair">
                  <code>{suggestion.leftLabel}</code>
                  <span className="join-suggestions__arrow" aria-hidden="true">
                    ↔
                  </span>
                  <code>{suggestion.rightLabel}</code>
                </div>
                <div className="join-suggestions__meta">
                  <span className="join-suggestions__overlap">
                    {suggestion.overlapPercent}% match · {suggestion.sharedValues} shared
                  </span>
                  {suggestion.grainLabel ? (
                    <span className="join-suggestions__grain" title="Inferred relationship grain">
                      {suggestion.grainLabel}
                    </span>
                  ) : null}
                  {suggestion.warning ? (
                    <span className="join-suggestions__warning" title={suggestion.warning}>
                      ⚠ {suggestion.warning}
                    </span>
                  ) : null}
                </div>
                <button
                  type="button"
                  className="join-suggestions__apply"
                  onClick={() => handleApplyJoin(suggestion.candidate)}
                >
                  Apply
                </button>
              </li>
            ))}
          </ul>
        </>
      ) : null}

      {keySuggestions.length > 0 ? (
        <>
          <header className="join-suggestions__header">
            <span>Suggested keys</span>
            <span className="join-suggestions__subtle">unique &amp; non-null in your data</span>
          </header>

          <ul className="join-suggestions__list">
            {keySuggestions.map((suggestion) => (
              <li key={suggestion.id} className="join-suggestions__item">
                <div className="join-suggestions__pair">
                  <code>{suggestion.label}</code>
                </div>
                <div className="join-suggestions__meta">
                  <span className="join-suggestions__overlap">{suggestion.reason}</span>
                </div>
                <button
                  type="button"
                  className="join-suggestions__apply"
                  onClick={() => handleApplyKey(suggestion)}
                >
                  Set PK
                </button>
              </li>
            ))}
          </ul>
        </>
      ) : null}

      {typeSuggestions.length > 0 ? (
        <>
          <header className="join-suggestions__header">
            <span>Suggested types</span>
            <span className="join-suggestions__subtle">from the values, not the default</span>
          </header>

          <ul className="join-suggestions__list">
            {typeSuggestions.map((suggestion) => (
              <li key={suggestion.id} className="join-suggestions__item">
                <div className="join-suggestions__pair">
                  <code>{suggestion.label}</code>
                  <span className="join-suggestions__arrow" aria-hidden="true">
                    →
                  </span>
                  <code>{suggestion.suggestedType}</code>
                </div>
                <div className="join-suggestions__meta">
                  <span className="join-suggestions__overlap">{suggestion.reason}</span>
                </div>
                <button
                  type="button"
                  className="join-suggestions__apply"
                  onClick={() => handleApplyType(suggestion)}
                >
                  Set type
                </button>
              </li>
            ))}
          </ul>
        </>
      ) : null}
    </section>
  );
}
