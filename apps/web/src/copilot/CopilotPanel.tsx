import { applyActions } from "@schema-studio/core";
import type { Schema } from "@schema-studio/core";
import { useEffect, useRef, useState } from "react";

import { useAiProvider } from "../ai/useAiProvider.js";
import { layoutSchema } from "../canvas/layout.js";
import { useSchemaStore } from "../store/index.js";
import { SuggestionsTab, useSuggestions } from "../suggest/index.js";
import {
  CheckIcon,
  ChevronDownIcon,
  DownloadIcon,
  InfoIcon,
  LockIcon,
  PanelOpenIcon,
  SendIcon,
  SparkleIcon,
} from "../ui/icons.js";
import "./CopilotPanel.css";
import { Markdown } from "./Markdown.js";
import { ModelPicker } from "./ModelPicker.js";
import {
  collectAffectedTableIds,
  formatRejectedAction,
  summarizeAppliedActions,
} from "./formatActions.js";
import { DEFAULT_MAX_ITERATIONS, type LoopOutcome, runCopilotLoop } from "./agentLoop.js";
import { buildConversationHistory } from "./conversation.js";
import { type ChatMessage, nextMessageId } from "./messages.js";

/** A note appended to the reply when the loop stopped for a reason other than clean completion. */
function outcomeFooter(outcome: LoopOutcome, attempts: number): string | null {
  switch (outcome) {
    case "exhausted":
      return `_Stopped after ${attempts} attempts with unresolved issues — try refining the request._`;
    case "stalled":
      return "_Stopped: the same actions kept being rejected._";
    case "cancelled":
      return "_Cancelled._";
    case "complete":
    case "blocked":
      return null;
  }
}

/**
 * Collapses the changes one Copilot turn applied into a single "Applied · N" card. Collapsed by
 * default so a turn that touches many fields reads as one line; expand to see each change.
 */
function AppliedCard({ lines }: { lines: string[] }) {
  const [open, setOpen] = useState(false);
  const count = lines.length;

  return (
    <div className={`copilot-applied${open ? " is-open" : ""}`}>
      <button
        type="button"
        className="copilot-applied__head"
        onClick={() => setOpen((value) => !value)}
        aria-expanded={open}
      >
        <CheckIcon size={15} />
        <span className="copilot-applied__title">
          <strong>Applied</strong> · {count} {count === 1 ? "change" : "changes"}
        </span>
        <ChevronDownIcon size={15} className="copilot-applied__chevron" />
      </button>
      {open ? (
        <ul className="copilot-applied__list">
          {lines.map((line) => (
            <li key={line} className="copilot-applied__item">
              {line}
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

export type CopilotTab = "chat" | "suggestions";

/**
 * Seeds the Copilot when the editor is entered from the New Project modal. `message` pre-fills the
 * chat input; when `autoDraft` is set (and a provider is connected), the Copilot runs it on mount
 * to draft a schema, surfaced as a reviewable ghost proposal rather than applied directly.
 */
export type CopilotKickoff = { message: string; autoDraft: boolean };

export function CopilotPanel({
  onConnect,
  kickoff,
  tab,
  onTabChange,
  activeSuggestionId,
  onActivateSuggestion,
  collapsed,
  onToggleCollapse,
}: {
  onConnect: () => void;
  kickoff?: CopilotKickoff | undefined;
  tab: CopilotTab;
  onTabChange: (tab: CopilotTab) => void;
  activeSuggestionId: string | null;
  onActivateSuggestion: (id: string | null) => void;
  collapsed: boolean;
  onToggleCollapse: () => void;
}) {
  const provider = useAiProvider();
  const suggestions = useSuggestions();
  const [draft, setDraft] = useState(kickoff?.message ?? "");
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<{ attempt: number; max: number } | null>(null);
  const cancelledRef = useRef(false);
  const chatEndRef = useRef<HTMLDivElement>(null);
  const kickedOffRef = useRef(false);

  const runActions = useSchemaStore((state) => state.runActions);
  const selectTable = useSchemaStore((state) => state.selectTable);
  const setSchemaDraft = useSchemaStore((state) => state.setDraft);
  const schemaDraft = useSchemaStore((state) => state.draft);
  const liveTables = useSchemaStore((state) => state.schema.tables);
  const messages = useSchemaStore((state) => state.chat);
  const appendChatMessages = useSchemaStore((state) => state.appendChatMessages);

  // Proposed (ghost) tables not yet in the live schema — surfaced in the Suggestions tab.
  const draftTableCount = schemaDraft
    ? schemaDraft.tables.filter((table) => !liveTables.some((live) => live.id === table.id)).length
    : 0;

  const scrollToBottom = () => {
    requestAnimationFrame(() => {
      chatEndRef.current?.scrollIntoView({ behavior: "smooth" });
    });
  };

  const handleSend = async () => {
    const text = draft.trim();
    if (!text || !provider || busy) {
      return;
    }

    // Capture history from the conversation so far, before appending the new user turn.
    const history = buildConversationHistory(messages);

    setDraft("");
    appendChatMessages([{ id: nextMessageId(), role: "user", text }]);
    setBusy(true);
    cancelledRef.current = false;
    scrollToBottom();

    let attempt = 0;

    try {
      const result = await runCopilotLoop({
        message: text,
        history,
        maxIterations: DEFAULT_MAX_ITERATIONS,
        isCancelled: () => cancelledRef.current,
        // Read the schema/sources fresh each round so the model sees the canvas as updated by
        // the previous round's applied actions, not the stale snapshot from render.
        propose: async (message, turns) => {
          attempt += 1;
          setProgress({ attempt, max: DEFAULT_MAX_ITERATIONS });
          scrollToBottom();
          const state = useSchemaStore.getState();
          const proposed = await provider.propose(state.schema, state.sources, message, turns);
          return {
            reply: proposed.reply,
            actions: proposed.actions,
            status: proposed.status ?? "needs_revision",
          };
        },
        apply: (actions) => {
          const { applied, rejected } = runActions(actions);
          const updatedSchema = useSchemaStore.getState().schema;

          const affectedTableIds = collectAffectedTableIds(applied);
          if (affectedTableIds[0]) {
            selectTable(affectedTableIds[0]);
          }

          return {
            applied: applied.length > 0 ? summarizeAppliedActions(updatedSchema, applied) : [],
            rejected,
          };
        },
      });

      const last = result.steps[result.steps.length - 1];
      const appliedAll = result.steps.flatMap((step) => step.applied);
      const rejectedFinal = last?.rejected ?? [];
      const footer = outcomeFooter(result.outcome, result.steps.length);
      const reply = last?.reply || "(No reply text returned.)";

      const assistantMessage: ChatMessage = {
        id: nextMessageId(),
        role: "assistant",
        text: footer ? `${reply}\n\n${footer}` : reply,
        ...(appliedAll.length > 0 ? { applied: appliedAll } : {}),
        ...(rejectedFinal.length > 0
          ? {
              rejected: rejectedFinal.map((entry) =>
                formatRejectedAction(entry.action, entry.reason),
              ),
            }
          : {}),
      };
      appendChatMessages([assistantMessage]);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Something went wrong talking to the copilot.";
      appendChatMessages([{ id: nextMessageId(), role: "error", text: message }]);
    } finally {
      setBusy(false);
      setProgress(null);
      scrollToBottom();
    }
  };

  /**
   * Draft an initial schema from the New Project context without applying it. Runs the same agent
   * loop as `handleSend`, but `apply` accumulates into a throwaway working copy (pure `applyActions`)
   * instead of the store — so nothing is committed. The result is laid out and stashed as the store
   * `draft`, which the canvas renders as a ghost proposal the user can Accept or Discard.
   */
  const runDraft = async (message: string) => {
    if (!provider || busy) {
      return;
    }

    onTabChange("chat");
    setDraft(""); // the kickoff seeded the input; clear it now that we're sending it ourselves
    appendChatMessages([{ id: nextMessageId(), role: "user", text: message }]);
    setBusy(true);
    cancelledRef.current = false;
    scrollToBottom();

    // Seed the working copy from the live schema (usually empty for a new project). The model
    // proposes against this evolving copy across rounds; the store is never touched here.
    let working: Schema = useSchemaStore.getState().schema;
    const makeId = () => crypto.randomUUID();
    let attempt = 0;

    try {
      const result = await runCopilotLoop({
        message,
        history: [],
        maxIterations: DEFAULT_MAX_ITERATIONS,
        isCancelled: () => cancelledRef.current,
        propose: async (msg, turns) => {
          attempt += 1;
          setProgress({ attempt, max: DEFAULT_MAX_ITERATIONS });
          scrollToBottom();
          const proposed = await provider.propose(
            working,
            useSchemaStore.getState().sources,
            msg,
            turns,
          );
          return {
            reply: proposed.reply,
            actions: proposed.actions,
            status: proposed.status ?? "needs_revision",
          };
        },
        apply: (actions) => {
          const r = applyActions(working, actions, { makeId });
          working = r.schema;
          return {
            applied: r.applied.length > 0 ? summarizeAppliedActions(working, r.applied) : [],
            rejected: r.rejected,
          };
        },
      });

      if (working.tables.length > 0) {
        // Lay the proposal out so ghost tables don't overlap, then stash it for the canvas.
        const positions = await layoutSchema(working);
        const byId = new Map(positions.map((p) => [p.tableId, p]));
        working = {
          ...working,
          tables: working.tables.map((table) => {
            const pos = byId.get(table.id);
            return pos ? { ...table, x: pos.x, y: pos.y } : table;
          }),
        };
        setSchemaDraft(working);
        // Surface the proposal in the Suggestions tab (where Accept/Discard also live).
        onTabChange("suggestions");
      }

      const last = result.steps[result.steps.length - 1];
      const reply = last?.reply || "(No reply text returned.)";
      const note =
        working.tables.length > 0
          ? `\n\n_Drafted ${working.tables.length} ${
              working.tables.length === 1 ? "table" : "tables"
            } — review and **Accept** or **Discard** on the canvas._`
          : "";
      appendChatMessages([{ id: nextMessageId(), role: "assistant", text: `${reply}${note}` }]);
    } catch (error) {
      const text =
        error instanceof Error ? error.message : "Something went wrong drafting the schema.";
      appendChatMessages([{ id: nextMessageId(), role: "error", text }]);
    } finally {
      setBusy(false);
      setProgress(null);
      scrollToBottom();
    }
  };

  // On entering the editor from the New Project modal with auto-draft on, kick off the draft once a
  // provider is available. The ref latches so it fires exactly once (provider can arrive a tick
  // late while the stored key hydrates). With no provider, the prompt just stays in the input.
  useEffect(() => {
    if (kickedOffRef.current || !kickoff?.autoDraft || !provider) {
      return;
    }
    kickedOffRef.current = true;
    void runDraft(kickoff.message);
  }, [kickoff, provider]);

  // The Suggestions tab is content-aware detector output and needs no API key, so the tab bar
  // appears whenever there are open suggestions — independent of `provider`. When there are
  // none, the pane behaves exactly as before (chat only).
  const showTabs = suggestions.openCount > 0 || draftTableCount > 0;
  const activeTab: CopilotTab = showTabs ? tab : "chat";

  if (collapsed) {
    return (
      <aside className="panel panel-rail">
        <button
          type="button"
          className="panel-rail__btn"
          onClick={onToggleCollapse}
          title="Expand Copilot"
          aria-label="Expand Copilot panel"
        >
          <PanelOpenIcon size={16} />
        </button>
        <span className="panel-rail__label">Copilot</span>
      </aside>
    );
  }

  return (
    <section className="panel copilot-panel">
      <header className="copilot-header">
        <span className="copilot-header__logo" aria-hidden>
          <SparkleIcon size={14} />
        </span>
        <h1 className="copilot-header__title">Copilot</h1>
        <button
          type="button"
          className="copilot-header__collapse"
          onClick={onToggleCollapse}
          aria-label="Collapse Copilot panel"
          title="Collapse panel"
        >
          <PanelOpenIcon size={16} />
        </button>
      </header>
      <div className="panel-body">
        {showTabs ? (
          <div className="copilot-tabs" role="tablist">
            <button
              type="button"
              role="tab"
              aria-selected={activeTab === "chat"}
              className={`copilot-tab${activeTab === "chat" ? " copilot-tab--active" : ""}`}
              onClick={() => onTabChange("chat")}
            >
              Chat
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={activeTab === "suggestions"}
              className={`copilot-tab${activeTab === "suggestions" ? " copilot-tab--active" : ""}`}
              onClick={() => onTabChange("suggestions")}
            >
              Suggestions
              <span className="copilot-tab__badge">{suggestions.openCount + draftTableCount}</span>
            </button>
          </div>
        ) : null}

        {activeTab === "suggestions" ? (
          <SuggestionsTab
            api={suggestions}
            activeId={activeSuggestionId}
            onActivate={onActivateSuggestion}
          />
        ) : null}

        {activeTab === "chat" ? (
          <>
            {!provider ? (
              <div className="copilot-cta">
                <span className="copilot-cta__icon" aria-hidden>
                  <SparkleIcon size={24} />
                  <span className="copilot-cta__lock">
                    <LockIcon size={11} />
                  </span>
                </span>
                <h2 className="copilot-cta__title">Connect AI to use Copilot</h2>
                <p className="copilot-cta__body">
                  Copilot reads your sample values locally and proposes joins between tables. Bring
                  your own key from Anthropic, OpenAI, or a local model to start.
                </p>
                <button type="button" className="copilot-cta__btn" onClick={onConnect}>
                  <DownloadIcon size={16} />
                  Connect a provider
                </button>
                <button type="button" className="copilot-cta__link" onClick={onConnect}>
                  Paste an API key instead
                </button>
                <span className="copilot-cta__trust">
                  <LockIcon size={12} />
                  Stored locally · never sent to our servers
                </span>
              </div>
            ) : (
              <div className="copilot-scroll">
                {messages.length > 0 ? (
                  <div className="copilot-chat">
                    {messages.map((message) => {
                      if (message.role === "user") {
                        return (
                          <div key={message.id} className="copilot-row copilot-row--user">
                            <div className="copilot-bubble copilot-bubble--user">
                              {message.text}
                            </div>
                          </div>
                        );
                      }

                      if (message.role === "error") {
                        return (
                          <div key={message.id} className="copilot-row copilot-row--assistant">
                            <span className="copilot-avatar copilot-avatar--error" aria-hidden>
                              <InfoIcon size={13} />
                            </span>
                            <div className="copilot-body copilot-body--error">{message.text}</div>
                          </div>
                        );
                      }

                      return (
                        <div key={message.id} className="copilot-row copilot-row--assistant">
                          <span className="copilot-avatar" aria-hidden>
                            <SparkleIcon size={13} />
                          </span>
                          <div className="copilot-body">
                            <Markdown>{message.text}</Markdown>
                            {message.applied && message.applied.length > 0 ? (
                              <AppliedCard lines={message.applied} />
                            ) : null}
                            {message.rejected
                              ? message.rejected.map((line) => (
                                  <div key={line} className="copilot-chip copilot-chip--rejected">
                                    <InfoIcon size={15} />
                                    <span>
                                      <strong>Couldn&apos;t apply</strong> · {line}
                                    </span>
                                  </div>
                                ))
                              : null}
                          </div>
                        </div>
                      );
                    })}
                    {busy ? (
                      <p className="copilot-status">
                        {progress && progress.attempt > 1
                          ? `Working… (step ${progress.attempt}/${progress.max})`
                          : "Thinking…"}
                      </p>
                    ) : null}
                    <div ref={chatEndRef} />
                  </div>
                ) : (
                  <p className="copilot-placeholder">
                    Ask about your sources and schema — e.g. link tables on a grant number and warn
                    if sample formats differ.
                  </p>
                )}
              </div>
            )}

            {provider ? (
              <div className="copilot-compose">
                <div className="copilot-compose__toolbar">
                  <ModelPicker onConnect={onConnect} />
                  {busy ? (
                    <button
                      type="button"
                      className="copilot-compose__cancel"
                      onClick={() => {
                        cancelledRef.current = true;
                      }}
                    >
                      Cancel
                    </button>
                  ) : null}
                </div>
                <div className="copilot-compose__shell">
                  <textarea
                    rows={1}
                    placeholder="Ask about your schema…"
                    value={draft}
                    disabled={busy}
                    onChange={(event) => setDraft(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" && !event.shiftKey) {
                        event.preventDefault();
                        void handleSend();
                      }
                    }}
                  />
                  <button
                    type="button"
                    className="copilot-compose__send"
                    onClick={() => void handleSend()}
                    disabled={busy}
                    aria-label="Send"
                  >
                    <SendIcon size={16} />
                  </button>
                </div>
              </div>
            ) : (
              <div className="copilot-compose">
                <div className="copilot-compose__toolbar">
                  <ModelPicker onConnect={onConnect} />
                </div>
                <div className="copilot-compose__shell is-locked">
                  <LockIcon size={15} className="copilot-compose__lock" />
                  <input
                    className="copilot-compose__locked-input"
                    placeholder="Connect a key to start chatting"
                    readOnly
                    disabled
                  />
                  <button
                    type="button"
                    className="copilot-compose__send"
                    disabled
                    aria-label="Send"
                    title="Connect a key to start chatting"
                  >
                    <SendIcon size={16} />
                  </button>
                </div>
              </div>
            )}
          </>
        ) : null}
      </div>
    </section>
  );
}
