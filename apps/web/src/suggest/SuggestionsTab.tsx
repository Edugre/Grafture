import { useMemo, useState } from "react";

import { buildSuggestionPreview } from "../canvas/suggestionPreview.js";
import { useSchemaStore } from "../store/index.js";
import { ChevronDownIcon, LinkIcon, SparkleIcon } from "../ui/icons.js";
import { useRankedSuggestions } from "./useRankedSuggestions.js";
import type { SuggestionItem, SuggestionsApi } from "./useSuggestions.js";
import "./SuggestionsTab.css";

type RankInfo = { order: number; rationale?: string; priority?: "high" | "normal" | "low" };

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
  const schema = useSchemaStore((state) => state.schema);
  const schemaDraft = useSchemaStore((state) => state.draft);
  const acceptDraft = useSchemaStore((state) => state.acceptDraft);
  const discardDraft = useSchemaStore((state) => state.discardDraft);
  const [message, setMessage] = useState<{ kind: "info" | "error"; text: string } | null>(null);

  // The AI-drafted initial schema (ghost proposal) surfaced here as a reviewable card. Only the
  // tables/relationships not already in the live schema are "proposed".
  const draftTables = useMemo(() => {
    if (!schemaDraft) {
      return [];
    }
    const liveIds = new Set(schema.tables.map((table) => table.id));
    return schemaDraft.tables.filter((table) => !liveIds.has(table.id));
  }, [schemaDraft, schema]);
  const draftRelCount = useMemo(() => {
    if (!schemaDraft) {
      return 0;
    }
    const liveIds = new Set(schema.relationships.map((relationship) => relationship.id));
    return schemaDraft.relationships.filter((relationship) => !liveIds.has(relationship.id)).length;
  }, [schemaDraft, schema]);
  const hasDraft = draftTables.length > 0;

  // Optional AI rerank layer. `reverted` lets the user drop back to the deterministic order without
  // turning the feature off; ranking is "active" only when a result is in and not reverted.
  const { ranked, status } = useRankedSuggestions(api);
  const [reverted, setReverted] = useState(false);
  const rankingActive = status === "ranked" && !reverted;

  const rankInfo = useMemo(() => {
    const map = new Map<string, RankInfo>();
    ranked.forEach((entry, order) =>
      map.set(entry.item.id, {
        order,
        ...(entry.rationale ? { rationale: entry.rationale } : {}),
        ...(entry.priority ? { priority: entry.priority } : {}),
      }),
    );
    return map;
  }, [ranked]);

  const orderItems = (items: SuggestionItem[]): SuggestionItem[] =>
    rankingActive
      ? [...items].sort(
          (a, b) => (rankInfo.get(a.id)?.order ?? 0) - (rankInfo.get(b.id)?.order ?? 0),
        )
      : items;

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
        {hasDraft ? (
          <section className="copilot-suggest-draft">
            <header className="copilot-suggest-draft__head">
              <span className="copilot-suggest-draft__icon" aria-hidden>
                <SparkleIcon size={14} />
              </span>
              <span className="copilot-suggest-draft__title">Initial schema draft</span>
            </header>
            <p className="copilot-suggest-draft__summary">
              {draftTables.length} {draftTables.length === 1 ? "table" : "tables"}
              {draftRelCount > 0
                ? ` · ${draftRelCount} ${draftRelCount === 1 ? "relationship" : "relationships"}`
                : ""}{" "}
              proposed
            </p>
            <div className="copilot-suggest-draft__chips">
              {draftTables.map((table) => (
                <span key={table.id} className="copilot-suggest-draft__chip">
                  {table.name}
                </span>
              ))}
            </div>
            <p className="copilot-suggest-draft__hint">
              Shown as a ghost on the canvas. Accept to add it, or discard it.
            </p>
            <div className="copilot-suggest-draft__actions">
              <button
                type="button"
                className="copilot-suggest-btn copilot-suggest-btn--ghost"
                onClick={() => {
                  discardDraft();
                  onActivate(null);
                }}
              >
                Discard
              </button>
              <button
                type="button"
                className="copilot-suggest-btn copilot-suggest-btn--primary"
                onClick={() => {
                  const result = acceptDraft();
                  if (!result.ok) {
                    // Also written to chat, but that tab may be hidden — report it here,
                    // where the Accept button the user just clicked lives.
                    setMessage({ kind: "error", text: result.error });
                  }
                  onActivate(null);
                }}
              >
                Accept draft
              </button>
            </div>
          </section>
        ) : null}

        {openCount > 0 ? (
          <p className="copilot-suggest-help">
            Select a suggestion to preview it on the canvas before applying.
          </p>
        ) : null}

        {status === "ranking" ? (
          <p className="copilot-suggest-rank">
            <SparkleIcon size={13} />
            <span className="copilot-suggest-rank__spin" aria-hidden />
            Ranking suggestions…
          </p>
        ) : status === "ranked" ? (
          <p className="copilot-suggest-rank">
            <SparkleIcon size={13} />
            {reverted ? "Showing default order" : "Ranked by AI"}
            <button
              type="button"
              className="copilot-suggest-rank__toggle"
              onClick={() => setReverted((value) => !value)}
            >
              {reverted ? "Show ranked" : "Show default"}
            </button>
          </p>
        ) : null}

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

            {orderItems(group.items).map((item) => {
              const open = activeId === item.id;
              // When the open card can't be located on the canvas (e.g. a join described in raw
              // source-column names against a remodeled schema), the overlay shows nothing — say so
              // on the card rather than leaving the canvas silently blank.
              const unpreviewable = open && buildSuggestionPreview(item, schema) === null;
              const info = rankingActive ? rankInfo.get(item.id) : undefined;
              return (
                <SuggestionCard
                  key={item.id}
                  item={item}
                  open={open}
                  unpreviewable={unpreviewable}
                  {...(info?.rationale ? { rationale: info.rationale } : {})}
                  {...(info?.priority ? { priority: info.priority } : {})}
                  onToggle={() => onActivate(open ? null : item.id)}
                  onApply={() => apply(item)}
                  onDismiss={() => dismiss(item)}
                />
              );
            })}
          </section>
        ))}
      </div>

      {openCount > 0 ? (
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
      ) : null}
    </>
  );
}

/** A collapsible suggestion card: header is the toggle; body (stats + actions) shows when open. */
function SuggestionCard({
  item,
  open,
  unpreviewable,
  rationale,
  priority,
  onToggle,
  onApply,
  onDismiss,
}: {
  item: SuggestionItem;
  open: boolean;
  unpreviewable: boolean;
  rationale?: string;
  priority?: "high" | "normal" | "low";
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
        {priority && priority !== "normal" ? (
          <span className={`copilot-suggest-prio copilot-suggest-prio--${priority}`}>
            {priority}
          </span>
        ) : null}
        <ChevronDownIcon size={16} className="copilot-suggest-card__chevron" />
      </button>

      {open ? (
        <div className="copilot-suggest-card__body">
          <div className="copilot-suggest-card__detail">{detailFor(item)}</div>
          {rationale ? <p className="copilot-suggest-card__rationale">{rationale}</p> : null}
          {unpreviewable ? (
            <p className="copilot-suggest-card__note">
              These columns aren’t on the canvas under these names, so it can’t be previewed. Apply
              it to add the link, or rename the fields to match the source.
            </p>
          ) : null}
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
