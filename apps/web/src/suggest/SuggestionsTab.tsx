import { useState } from "react";

import { ChevronDownIcon, LinkIcon } from "../ui/icons.js";
import type { SuggestionItem, SuggestionsApi } from "./useSuggestions.js";
import "./SuggestionsTab.css";

/**
 * SS-9 suggestions as the Copilot pane's "Suggestions" tab. Cards are a single-open accordion
 * (handoff: design_handoff_active_suggestion_preview): collapsed to one line by default, expanding
 * to reveal stats + Apply/Dismiss. The open card is the `active` suggestion — lifted to App and
 * shared with the canvas, which dims the schema and previews the proposed key/relationship.
 *
 * "Apply" flows through the validated store path; "Dismiss" hides a card without touching the
 * schema. Body + footer are siblings so they slot into the pane's flex column.
 */
export function SuggestionsTab({
  api,
  activeId,
  onActivate,
}: {
  api: SuggestionsApi;
  activeId: string | null;
  onActivate: (id: string | null) => void;
}) {
  const { groups, openCount, needsReviewCount } = api;
  const [message, setMessage] = useState<{ kind: "info" | "error"; text: string } | null>(null);

  const resolveActive = (id: string) => {
    // The applied/dismissed card is gone; collapse the preview if it was the active one.
    if (activeId === id) {
      onActivate(null);
    }
  };

  const apply = (item: SuggestionItem) => {
    const outcome = api.apply(item);
    resolveActive(item.id);
    setMessage(
      outcome.ok ? { kind: "info", text: outcome.label } : { kind: "error", text: outcome.error },
    );
  };

  const dismiss = (item: SuggestionItem) => {
    api.dismiss(item.id);
    resolveActive(item.id);
  };

  const applyAll = () => {
    // Snapshot first: applying mutates the schema, which re-derives `open` mid-iteration.
    const items = [...api.open];
    let applied = 0;
    let lastError: string | null = null;
    for (const item of items) {
      const outcome = api.apply(item);
      if (outcome.ok) {
        applied += 1;
      } else {
        lastError = outcome.error;
      }
    }
    onActivate(null);
    if (lastError && applied === 0) {
      setMessage({ kind: "error", text: lastError });
    } else {
      setMessage({
        kind: "info",
        text: `Applied ${applied} suggestion${applied === 1 ? "" : "s"}.`,
      });
    }
  };

  const dismissAll = () => {
    api.dismissAll();
    onActivate(null);
  };

  return (
    <>
      <div className="copilot-suggest-body">
        <p className="copilot-suggest-help">
          Select a suggestion to preview it on the canvas before applying.
        </p>

        {message ? (
          <p className={`copilot-suggest-message copilot-suggest-message--${message.kind}`}>
            {message.text}
          </p>
        ) : null}

        {groups.map((group) => (
          <section key={group.key} className="copilot-suggest-group">
            <header className="copilot-suggest-grouphead">
              <span className="copilot-suggest-grouphead__label">{group.label}</span>
              <span className="copilot-suggest-grouphead__count">{group.items.length}</span>
              <span className="copilot-suggest-grouphead__rule" aria-hidden />
            </header>

            {group.items.map((item) => (
              <SuggestionCard
                key={item.id}
                item={item}
                open={activeId === item.id}
                onToggle={() => onActivate(activeId === item.id ? null : item.id)}
                onApply={() => apply(item)}
                onDismiss={() => dismiss(item)}
              />
            ))}
          </section>
        ))}
      </div>

      <div className="copilot-suggest-footer">
        <span className="copilot-suggest-footer__status">
          {needsReviewCount > 0 ? (
            <span className="copilot-suggest-amber">{needsReviewCount} needs review</span>
          ) : (
            `${openCount} open`
          )}
        </span>
        <div className="copilot-suggest-footer__actions">
          <button
            type="button"
            className="copilot-suggest-btn copilot-suggest-btn--ghost"
            onClick={dismissAll}
          >
            Dismiss all
          </button>
          <button
            type="button"
            className="copilot-suggest-btn copilot-suggest-btn--primary"
            onClick={applyAll}
          >
            Apply all {openCount}
          </button>
        </div>
      </div>
    </>
  );
}

/** A collapsible suggestion card: header is the toggle; body (stats + actions) shows when open. */
function SuggestionCard({
  item,
  open,
  onToggle,
  onApply,
  onDismiss,
}: {
  item: SuggestionItem;
  open: boolean;
  onToggle: () => void;
  onApply: () => void;
  onDismiss: () => void;
}) {
  return (
    <div className={`copilot-suggest-card${open ? " is-open" : ""}`}>
      <button type="button" className="copilot-suggest-card__header" onClick={onToggle}>
        <CardIndicator item={item} />
        <span className="copilot-suggest-card__title">
          <CardTitle item={item} />
        </span>
        <ChevronDownIcon size={16} className="copilot-suggest-card__chevron" />
      </button>

      {open ? (
        <div className="copilot-suggest-card__body">
          <div className="copilot-suggest-card__detail">{detailFor(item)}</div>
          <div className="copilot-suggest-card__actions">
            <button
              type="button"
              className="copilot-suggest-btn copilot-suggest-btn--ghost"
              onClick={(event) => {
                event.stopPropagation();
                onDismiss();
              }}
            >
              Dismiss
            </button>
            <button
              type="button"
              className="copilot-suggest-btn copilot-suggest-btn--primary"
              onClick={(event) => {
                event.stopPropagation();
                onApply();
              }}
            >
              Apply
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}

function CardIndicator({ item }: { item: SuggestionItem }) {
  if (item.group === "fk") {
    return (
      <span className="copilot-suggest-card__icon" aria-hidden>
        <LinkIcon size={15} />
      </span>
    );
  }
  return <span className="copilot-suggest-card__dot" aria-hidden />;
}

function CardTitle({ item }: { item: SuggestionItem }) {
  if (item.group === "pk") {
    return (
      <>
        Primary key: <code>{item.key.label.replace(" · ", ".")}</code>
      </>
    );
  }
  if (item.group === "fk") {
    return (
      <>
        {item.join.grainLabel === "N:M" ? "Relationship" : "FK"}:{" "}
        <code>{item.join.leftLabel.replace(" · ", ".")}</code> →{" "}
        <code>{item.join.rightLabel.replace(" · ", ".")}</code>
      </>
    );
  }
  return (
    <>
      Type: <code>{item.type.label.replace(" · ", ".")}</code> →{" "}
      <code>{item.type.suggestedType}</code>
    </>
  );
}

function detailFor(item: SuggestionItem): string {
  if (item.group === "pk") {
    return item.key.reason;
  }
  if (item.group === "fk") {
    const grain = item.join.grainLabel ? ` · grain ${item.join.grainLabel}` : "";
    const warn = item.join.warning ? ` · ⚠ ${item.join.warning}` : "";
    return `${item.join.overlapPercent}% value overlap · ${item.join.sharedValues} shared${grain}${warn}`;
  }
  return item.type.reason;
}
