import type { AiProvider } from "@schema-studio/core";
import { useMemo, useRef, useState } from "react";

import { AnthropicBrowserProvider } from "../ai/AnthropicBrowserProvider.js";
import { useSchemaStore } from "../store/index.js";
import { SuggestionsTab, useSuggestions } from "../suggest/index.js";
import { CheckIcon, DownloadIcon, InfoIcon, LockIcon, SendIcon, SparkleIcon } from "../ui/icons.js";
import { useApiKeyContext } from "./ApiKeyContext.js";
import "./CopilotPanel.css";
import { Markdown } from "./Markdown.js";
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

export type CopilotTab = "chat" | "suggestions";

export function CopilotPanel({
  onConnect,
  tab,
  onTabChange,
  activeSuggestionId,
  onActivateSuggestion,
}: {
  onConnect: () => void;
  tab: CopilotTab;
  onTabChange: (tab: CopilotTab) => void;
  activeSuggestionId: string | null;
  onActivateSuggestion: (id: string | null) => void;
}) {
  const { apiKey } = useApiKeyContext();
  const suggestions = useSuggestions();
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState<{ attempt: number; max: number } | null>(null);
  const cancelledRef = useRef(false);
  const chatEndRef = useRef<HTMLDivElement>(null);

  const runActions = useSchemaStore((state) => state.runActions);
  const selectTable = useSchemaStore((state) => state.selectTable);
  const messages = useSchemaStore((state) => state.chat);
  const appendChatMessages = useSchemaStore((state) => state.appendChatMessages);

  const provider = useMemo((): AiProvider | null => {
    const trimmed = apiKey.trim();
    if (!trimmed) {
      return null;
    }
    return new AnthropicBrowserProvider(trimmed);
  }, [apiKey]);

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

  // The Suggestions tab is content-aware detector output and needs no API key, so the tab bar
  // appears whenever there are open suggestions — independent of `provider`. When there are
  // none, the pane behaves exactly as before (chat only).
  const showTabs = suggestions.openCount > 0;
  const activeTab: CopilotTab = showTabs ? tab : "chat";

  return (
    <section className="panel copilot-panel">
      <header className="copilot-header">
        <span className="copilot-header__logo" aria-hidden>
          <SparkleIcon size={14} />
        </span>
        <h1 className="copilot-header__title">Copilot</h1>
        <span className="copilot-header__tag">SS-9 detector</span>
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
              <span className="copilot-tab__badge">{suggestions.openCount}</span>
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
                            {message.applied
                              ? message.applied.map((line) => (
                                  <div key={line} className="copilot-chip copilot-chip--applied">
                                    <CheckIcon size={15} />
                                    <span>
                                      <strong>Applied</strong> · {line}
                                    </span>
                                  </div>
                                ))
                              : null}
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
