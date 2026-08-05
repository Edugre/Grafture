import { applyActions } from "@grafture/core";
import type { Schema } from "@grafture/core";
import { useEffect, useRef, useState } from "react";

import { useAiProvider } from "../ai/useAiProvider.js";
import {
  type Attempt,
  ProviderError,
  type RetryProgress,
  RetryStoppedError,
  subscribeToRetries,
} from "../ai/retry.js";
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
import { afterPaint } from "./afterPaint.js";
import { Markdown } from "./Markdown.js";
import { ModelPicker } from "./ModelPicker.js";
import {
  collectAffectedTableIds,
  formatRejectedAction,
  summarizeAppliedActions,
} from "./formatActions.js";
import { DEFAULT_MAX_ITERATIONS, type LoopOutcome, runCopilotLoop } from "./agentLoop.js";
import { buildConversationHistory } from "./conversation.js";
import { CopilotErrorRow, CopilotRecovered, CopilotRetrying } from "./CopilotError.js";
import {
  type CopilotFailure,
  type FailureActionId,
  describeFailure,
  toProviderFailure,
} from "./failureCopy.js";
import { type ChatMessage, nextMessageId } from "./messages.js";
import { warmDetectorFindings } from "./systemPrompt.js";

/**
 * Everything one turn's backoff episodes added up to. The agent loop can make several requests per
 * turn, so a turn's ledger is the concatenation of each episode's attempts (renumbered so the rows
 * still read 1, 2, 3…) and the sum of their elapsed times. Showing only the last episode would
 * quietly under-report how much retrying the turn actually did.
 */
type TurnRetryLog = { attempts: Attempt[]; elapsedMs: number; stopped: boolean };

function appendEpisode(
  log: TurnRetryLog,
  attempts: Attempt[],
  elapsedMs: number,
  stopped: boolean,
) {
  for (const attempt of attempts) {
    log.attempts.push({ ...attempt, n: log.attempts.length + 1 });
  }
  log.elapsedMs += elapsedMs;
  log.stopped = log.stopped || stopped;
}

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
  // The live backoff block. Transient by design: it belongs to the request in flight, not to the
  // transcript — what lands in history is the ledger it leaves behind.
  const [retrying, setRetrying] = useState<RetryProgress | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  /**
   * Spoken when a turn ends without a reply. Deliberately panel-level and written only from the
   * failure path — a `role="alert"` on the card itself would also fire for every failure loaded
   * out of a saved transcript, announcing week-old errors on project open.
   */
  const [announcement, setAnnouncement] = useState("");
  const retryLogRef = useRef<TurnRetryLog>({ attempts: [], elapsedMs: 0, stopped: false });
  const cancelledRef = useRef(false);
  const chatEndRef = useRef<HTMLDivElement>(null);
  const kickedOffRef = useRef(false);

  const runActions = useSchemaStore((state) => state.runActions);
  const selectTable = useSchemaStore((state) => state.selectTable);
  const setSchemaDraft = useSchemaStore((state) => state.setDraft);
  const schemaDraft = useSchemaStore((state) => state.draft);
  const liveTables = useSchemaStore((state) => state.schema.tables);
  const sources = useSchemaStore((state) => state.sources);
  const messages = useSchemaStore((state) => state.chat);
  const appendChatMessages = useSchemaStore((state) => state.appendChatMessages);

  // The detector pass the system prompt embeds is the copilot's most expensive step (~3.7s on the
  // real HRSA + OPAIS files) and depends only on the sources. Run it while the user is still
  // reading the canvas, so the first send doesn't pay for it. Cached by source identity, so this
  // is a no-op once warm and re-warms whenever a file is added or removed.
  useEffect(() => {
    if (sources.length === 0) {
      return;
    }
    if (typeof window.requestIdleCallback !== "function") {
      const timer = window.setTimeout(() => warmDetectorFindings(sources), 300);
      return () => window.clearTimeout(timer);
    }
    const handle = window.requestIdleCallback(() => warmDetectorFindings(sources));
    return () => window.cancelIdleCallback(handle);
  }, [sources]);

  // The retry wrapper drives the lifecycle; this only mirrors it into render state. Subscribing
  // once for the panel's life is safe because exactly one turn runs at a time (the `busy` gate).
  useEffect(
    () =>
      subscribeToRetries((event) => {
        if (event.type === "waiting") {
          setRetrying(event.progress);
          scrollToBottom();
          return;
        }
        // `attempting` means the wait ended and the request is back in flight — drop the backoff
        // block so "Thinking…" returns, but do NOT close the episode: the ledger is still growing.
        if (event.type === "attempting") {
          setRetrying(null);
          return;
        }
        appendEpisode(retryLogRef.current, event.attempts, event.elapsedMs, event.stopped);
        setRetrying(null);
      }),
    [],
  );

  /** Take (and clear) the ledger this turn accumulated, for attaching to the resulting message. */
  const takeRetryLog = (): TurnRetryLog => {
    const log = retryLogRef.current;
    retryLogRef.current = { attempts: [], elapsedMs: 0, stopped: false };
    return log;
  };

  /**
   * Build the persisted facts of a failed turn. Only measurements and classifications — the card's
   * sentences are derived at render time, so a copy fix reaches transcripts saved before it.
   * Returns undefined for anything that never came through the wrapper, which then renders as the
   * plain message it always did.
   */
  const failureDetail = (error: unknown, retryMessage: string): CopilotFailure | undefined => {
    if (!(error instanceof ProviderError)) {
      return undefined;
    }
    // The ledger on the card is the *failing request's* — `error.attempts` — never the turn's
    // accumulated log. A turn can retry successfully in round 1 and then fail outright in round 2;
    // showing round 1's rows against round 2's failure invents a history. It also fools
    // `failurePhase` into reading two-or-more rows as `interrupted`, which then narrates a
    // transition ("the second attempt came back refused rather than rate limited") that never
    // happened. The turn log's only job is the recovered line on a turn that succeeded.
    return {
      failure: error.failure,
      providerLabel: error.context.label,
      providerId: error.context.family,
      ...(error.attempts.length > 0 ? { attempts: error.attempts } : {}),
      ...(error.requestId ? { requestId: error.requestId } : {}),
      elapsedMs: error.elapsedMs,
      ...(error.context.attemptTimeoutMs ? { timeoutMs: error.context.attemptTimeoutMs } : {}),
      ...(error.context.modelId ? { modelId: error.context.modelId } : {}),
      sourceCount: useSchemaStore.getState().sources.length,
      retryMessage,
    };
  };

  // Proposed (ghost) tables not yet in the live schema — surfaced in the Suggestions tab.
  const draftTableCount = schemaDraft
    ? schemaDraft.tables.filter((table) => !liveTables.some((live) => live.id === table.id)).length
    : 0;

  const scrollToBottom = () => {
    requestAnimationFrame(() => {
      chatEndRef.current?.scrollIntoView({ behavior: "smooth" });
    });
  };

  /**
   * Send one turn. `override` re-sends an earlier message (the failure card's "Try again") through
   * exactly this path rather than a shortcut: same history capture, same provenance actor, same
   * history step. A retry that bypassed this would quietly be a different kind of turn.
   */
  const handleSend = async (override?: string) => {
    const text = (override ?? draft).trim();
    if (!text || !provider || busy) {
      return;
    }

    // Capture history from the conversation so far, before appending the new user turn.
    const history = buildConversationHistory(messages);
    // One id for the whole send, not per round: the loop may take several rounds to satisfy a
    // single request, and every rationale it writes belongs to that one turn.
    const turnId = nextMessageId();

    setDraft("");
    setAnnouncement("");
    appendChatMessages([{ id: nextMessageId(), role: "user", text }]);
    setBusy(true);
    cancelledRef.current = false;
    scrollToBottom();
    // Let the optimistic bubble + "Thinking…" paint before propose() builds the prompt (which runs
    // the detectors synchronously) — otherwise the send click looks like a freeze.
    await afterPaint();

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
          const proposed = await provider.propose(state.schema, state.sources, message, turns, {
            intent: "chat",
          });
          return {
            reply: proposed.reply,
            actions: proposed.actions,
            status: proposed.status ?? "needs_revision",
            notice: proposed.notice,
          };
        },
        apply: (actions) => {
          const { applied, rejected } = runActions(actions, { actor: "ai", turnId });
          const updatedSchema = useSchemaStore.getState().schema;

          const affectedTableIds = collectAffectedTableIds(applied);
          if (affectedTableIds[0]) {
            selectTable(affectedTableIds[0]);
          }
          // Switch the canvas into review mode the moment the copilot changes something: this is
          // the window where "the AI proposed this, and here is why" is worth the screen space.
          // The user can toggle it back off; nothing re-enables it until the next copilot edit.
          if (applied.length > 0) {
            useSchemaStore.getState().setReviewMode(true);
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
      // A provider notice can be raised on any round (the fallback latches on the first), so take
      // the first one seen rather than only the last step's.
      const notice = result.steps.find((step) => step.notice)?.notice;

      // A turn that only got through after backing off keeps its record, at one line's volume.
      const retryLog = takeRetryLog();

      const assistantMessage: ChatMessage = {
        id: nextMessageId(),
        role: "assistant",
        text: footer ? `${reply}\n\n${footer}` : reply,
        ...(retryLog.attempts.length > 0
          ? { retry: { attempts: retryLog.attempts, totalMs: retryLog.elapsedMs } }
          : {}),
        ...(notice ? { notice } : {}),
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
      appendChatMessages([failedTurnMessage(error, text)]);
    } finally {
      setBusy(false);
      setProgress(null);
      setRetrying(null);
      scrollToBottom();
    }
  };

  /**
   * The transcript entry for a turn that didn't produce a reply.
   *
   * A user-initiated Stop is not an error — it gets an ordinary assistant turn wearing the ledger
   * it stopped, so an abandoned retry never reads as a crash. Everything else becomes an error
   * message; when it came through the retry wrapper it also carries the classified detail the
   * failure card is built from, and when it didn't it renders exactly as it always did.
   */
  const failedTurnMessage = (error: unknown, sentText: string): ChatMessage => {
    // Drain first and unconditionally: every terminal path has to clear the turn's log, or a
    // recovered episode from this turn rides along on the *next* turn's reply as a ledger for
    // attempts it never made. The early return below (a non-ProviderError) used to skip this.
    const log = takeRetryLog();
    if (error instanceof RetryStoppedError) {
      const attempts = log.attempts.length > 0 ? log.attempts : error.attempts;
      setAnnouncement("Stopped retrying.");
      return {
        id: nextMessageId(),
        role: "assistant",
        text: "_Stopped retrying._",
        ...(attempts.length > 0
          ? { retry: { attempts, totalMs: log.elapsedMs || error.elapsedMs, stopped: true } }
          : {}),
      };
    }
    const detail = failureDetail(error, sentText);
    const message =
      error instanceof Error ? error.message : "Something went wrong talking to the copilot.";
    // Announce the card's own title, not the raw provider string — the title is the sentence the
    // card was written to lead with, and the raw string is a JSON blob.
    setAnnouncement(
      detail ? `Copilot failed. ${describeFailure(detail).title}.` : `Copilot failed. ${message}`,
    );
    return {
      id: nextMessageId(),
      role: "error",
      text: message,
      ...(detail ? { detail } : {}),
    };
  };

  /** Run a failure card's primary action. The card names the intent; the panel owns the wiring. */
  const runFailureAction = (id: FailureActionId, detail: CopilotFailure) => {
    if (id === "retry" && detail.retryMessage) {
      void handleSend(detail.retryMessage);
      return;
    }
    if (id === "connect") {
      onConnect();
      return;
    }
    if (id === "pick-model") {
      setPickerOpen(true);
    }
  };

  /** Drop a failure card from the transcript. */
  const dismissMessage = (id: string) => {
    useSchemaStore.getState().removeChatMessage(id);
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
    setAnnouncement("");
    appendChatMessages([{ id: nextMessageId(), role: "user", text: message }]);
    setBusy(true);
    cancelledRef.current = false;
    scrollToBottom();
    await afterPaint();

    // Seed the working copy from the live schema (usually empty for a new project). The model
    // proposes against this evolving copy across rounds; the store is never touched here.
    let working: Schema = useSchemaStore.getState().schema;
    const makeId = () => crypto.randomUUID();
    // This path applies through core directly rather than the store — it must therefore declare
    // the actor itself. Without it the draft takes the "user" default, and the whole auto-drafted
    // schema would land unattributed with every rationale silently dropped.
    const turnId = nextMessageId();
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
            { intent: "derive" },
          );
          return {
            reply: proposed.reply,
            actions: proposed.actions,
            status: proposed.status ?? "needs_revision",
          };
        },
        apply: (actions) => {
          const r = applyActions(working, actions, { makeId, actor: "ai", turnId });
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
      const retryLog = takeRetryLog();
      appendChatMessages([
        {
          id: nextMessageId(),
          role: "assistant",
          text: `${reply}${note}`,
          ...(retryLog.attempts.length > 0
            ? { retry: { attempts: retryLog.attempts, totalMs: retryLog.elapsedMs } }
            : {}),
        },
      ]);
    } catch (error) {
      // The auto-draft turn has a visible transcript slot of its own (its prompt was appended as a
      // user message above), so its failures get the same card as a typed turn — no separate surface.
      appendChatMessages([failedTurnMessage(error, message)]);
    } finally {
      setBusy(false);
      setProgress(null);
      setRetrying(null);
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
              // Both branches carry the tour's `chat` anchor: with no key the CTA *is* what the
              // chat step is describing, and its copy says the step's note out loud.
              <div className="copilot-cta" data-tour="chat">
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
              <div className="copilot-scroll" data-tour="chat">
                {/* Always mounted so the text swap is what announces, not the node's arrival. */}
                <span className="sr-only" role="status">
                  {announcement}
                </span>
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
                        // A failure classified by the retry wrapper gets a card in the assistant
                        // slot; anything else (or a `kind` this build predates) keeps the raw
                        // message it always had, which is honest rather than a guessed cause.
                        const known = message.detail
                          ? toProviderFailure(message.detail.failure)
                          : null;
                        if (!message.detail || !known) {
                          return (
                            <div key={message.id} className="copilot-row copilot-row--assistant">
                              <span className="copilot-avatar copilot-avatar--error" aria-hidden>
                                <InfoIcon size={13} />
                              </span>
                              <div className="copilot-body copilot-body--error">{message.text}</div>
                            </div>
                          );
                        }
                        const detail: CopilotFailure = { ...message.detail, failure: known };
                        return (
                          <CopilotErrorRow
                            key={message.id}
                            detail={detail}
                            onAction={(id) => runFailureAction(id, detail)}
                            onDismiss={() => dismissMessage(message.id)}
                          />
                        );
                      }

                      return (
                        <div key={message.id} className="copilot-row copilot-row--assistant">
                          <span className="copilot-avatar" aria-hidden>
                            <SparkleIcon size={13} />
                          </span>
                          <div className="copilot-body">
                            {message.retry ? (
                              <CopilotRecovered
                                attempts={message.retry.attempts}
                                totalMs={message.retry.totalMs}
                                stopped={message.retry.stopped}
                              />
                            ) : null}
                            <Markdown>{message.text}</Markdown>
                            {message.notice ? (
                              <div className="copilot-chip copilot-chip--notice">
                                <InfoIcon size={15} />
                                <Markdown>{message.notice}</Markdown>
                              </div>
                            ) : null}
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
                    {/* While backing off, the wait replaces the thinking dots rather than sitting
                        beside them: the copilot is not thinking, it is waiting, and saying both at
                        once would be one of them lying. */}
                    {busy && retrying ? (
                      <div className="copilot-row copilot-row--assistant">
                        <span className="copilot-avatar" aria-hidden>
                          <SparkleIcon size={13} />
                        </span>
                        <div className="copilot-body">
                          <CopilotRetrying progress={retrying} />
                        </div>
                      </div>
                    ) : null}
                    {busy && !retrying ? (
                      <div className="copilot-row copilot-row--assistant">
                        <span className="copilot-avatar" aria-hidden>
                          <SparkleIcon size={13} />
                        </span>
                        <p className="copilot-status" role="status">
                          <span className="copilot-status__dots" aria-hidden>
                            <i />
                            <i />
                            <i />
                          </span>
                          {progress && progress.attempt > 1
                            ? `Working… (step ${progress.attempt}/${progress.max})`
                            : "Thinking…"}
                        </p>
                      </div>
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
                  <ModelPicker
                    onConnect={onConnect}
                    open={pickerOpen}
                    onOpenChange={setPickerOpen}
                  />
                  {busy ? (
                    <button
                      type="button"
                      className="copilot-compose__cancel"
                      onClick={() => {
                        cancelledRef.current = true;
                        // Stopping mid-backoff must also abort the in-flight request and cancel
                        // the scheduled retry — cancelling only the loop would leave a request
                        // running that writes into a turn the user has abandoned.
                        retrying?.stop();
                      }}
                    >
                      {retrying ? "Stop retrying" : "Cancel"}
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
