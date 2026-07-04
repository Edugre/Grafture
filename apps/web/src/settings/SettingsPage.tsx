import { TARGET_PROFILES, TargetIdSchema, type TargetId } from "@schema-studio/core";
import { useState, type ReactNode } from "react";

import { setModelPreference, useModelPreference } from "../ai/modelPreference.js";
import { useProviderPreference } from "../ai/providerPreference.js";
import {
  PROVIDERS,
  PROVIDER_IDS,
  decodeProviderModel,
  effectiveCredential,
  encodeProviderModel,
} from "../ai/providers.js";
import { useAllModels } from "../ai/useModels.js";
import { useTargetPreference } from "../ai/targetPreference.js";
import { useApiKeyContext } from "../copilot/ApiKeyContext.js";
import { useAutoDraftPreference } from "../copilot/autoDraftPreference.js";
import { useRerankPreference } from "../suggest/rerankPreference.js";
import { useThemeContext, type Theme } from "../theme/ThemeContext.js";
import {
  ChevronLeftIcon,
  CreditCardIcon,
  GearIcon,
  GlobeIcon,
  InfoIcon,
  KeyIcon,
  MonitorIcon,
  MoonIcon,
  PlusIcon,
  ShieldIcon,
  SparkleIcon,
  SunIcon,
  TrashIcon,
  UsersIcon,
} from "../ui/icons.js";
import "./SettingsPage.css";

type SectionId = "general" | "api-keys" | "appearance" | "data" | "members" | "billing";

type NavItem = {
  id: SectionId;
  label: string;
  icon: ReactNode;
  enabled: boolean;
};

const NAV_ITEMS: NavItem[] = [
  { id: "general", label: "General", icon: <GearIcon size={16} />, enabled: false },
  { id: "api-keys", label: "API keys", icon: <KeyIcon size={16} />, enabled: true },
  { id: "appearance", label: "Appearance", icon: <GlobeIcon size={16} />, enabled: true },
  { id: "data", label: "Data & privacy", icon: <ShieldIcon size={16} />, enabled: false },
  { id: "members", label: "Members", icon: <UsersIcon size={16} />, enabled: false },
  { id: "billing", label: "Billing", icon: <CreditCardIcon size={16} />, enabled: false },
];

function maskKey(key: string): string {
  const trimmed = key.trim();
  if (trimmed.length <= 10) {
    return "•••• ••••";
  }
  return `${trimmed.slice(0, 14)} ···· ${trimmed.slice(-4)}`;
}

export function SettingsPage({ onBack, onAddKey }: { onBack: () => void; onAddKey: () => void }) {
  const [section, setSection] = useState<SectionId>("api-keys");

  return (
    <div className="settings">
      <header className="settings__topbar">
        <div className="settings__topbar-left">
          <button type="button" className="settings__back" onClick={onBack}>
            <ChevronLeftIcon size={16} />
            Back to app
          </button>
          <span className="settings__divider" />
          <span className="settings__wordmark">Settings</span>
        </div>
        <span className="settings__avatar" aria-hidden>
          SS
        </span>
      </header>

      <div className="settings__body">
        <nav className="settings__nav" aria-label="Settings sections">
          <span className="settings__nav-label">Workspace</span>
          {NAV_ITEMS.map((item) => {
            const active = item.id === section;
            return (
              <button
                key={item.id}
                type="button"
                className={`settings__nav-item${active ? " is-active" : ""}`}
                aria-current={active ? "page" : undefined}
                disabled={!item.enabled}
                title={item.enabled ? undefined : "Coming soon"}
                onClick={() => item.enabled && setSection(item.id)}
              >
                {item.icon}
                <span>{item.label}</span>
                {!item.enabled ? <span className="settings__nav-soon">Soon</span> : null}
              </button>
            );
          })}
        </nav>

        <main className="settings__content">
          {section === "api-keys" ? <ApiKeysSection onAddKey={onAddKey} /> : <AppearanceSection />}
        </main>
      </div>
    </div>
  );
}

function formatContext(maxInputTokens?: number): string {
  if (!maxInputTokens) {
    return "—";
  }
  return maxInputTokens >= 1_000_000
    ? `${Math.round(maxInputTokens / 1_000_000)}M tokens`
    : `${Math.round(maxInputTokens / 1_000)}K tokens`;
}

function ApiKeysSection({ onAddKey }: { onAddKey: () => void }) {
  const { provider, setProvider } = useProviderPreference();
  const { keyFor, setApiKey, setRemember } = useApiKeyContext();
  const { enabled: rerank, setEnabled: setRerank } = useRerankPreference();
  const { enabled: autoDraft, setEnabled: setAutoDraft } = useAutoDraftPreference();
  const { model } = useModelPreference(provider);
  const { models, loading: modelsLoading } = useAllModels();
  const { target, setTarget } = useTargetPreference();

  // Every provider that has an explicitly-entered credential, in registry order — the unified key
  // list. (Local with its default endpoint isn't listed here; it only appears once a custom
  // endpoint is saved, like a key.)
  const configured = PROVIDER_IDS.filter((id) => keyFor(id).apiKey.trim().length > 0);
  const anyKey = configured.length > 0;
  // Rerank + auto-draft run through the ACTIVE provider (useAiProvider), so they need the active
  // provider to be usable — a key, or local's default endpoint. Gating on a key alone would wrongly
  // disable them for a default-endpoint local provider (which needs no key).
  const activeReady = effectiveCredential(provider, keyFor(provider).apiKey).length > 0;

  // The dropdown value encodes the (provider, model) pair — a single option-value string routed
  // through the registry's encode/decode helpers so the separator convention lives in one place.
  const currentValue = encodeProviderModel(provider, model);
  const listed = models.some(
    (candidate) => encodeProviderModel(candidate.provider, candidate.id) === currentValue,
  );
  // Keep the saved model selectable even if no catalog/live list carries it. When no model is set
  // (local before a pick), label the placeholder rather than rendering a blank option.
  const allModels = listed
    ? models
    : [{ id: model, displayName: model || "Choose a model…", provider }, ...models];
  const selectedModel = allModels.find(
    (candidate) => encodeProviderModel(candidate.provider, candidate.id) === currentValue,
  );

  const chooseModel = (value: string) => {
    const decoded = decodeProviderModel(value);
    if (!decoded) {
      return;
    }
    // Set the chosen provider's model, then make that provider active so the copilot uses it.
    setModelPreference(decoded.provider, decoded.model);
    setProvider(decoded.provider);
  };

  return (
    <div className="settings__pane settings__pane--keys">
      <div className="settings__page-header">
        <div>
          <h1 className="settings__title">API keys</h1>
          <p className="settings__subtitle">
            Keys you bring to call AI providers directly from this browser.
          </p>
        </div>
        <button type="button" className="settings__btn settings__btn--primary" onClick={onAddKey}>
          <PlusIcon size={16} />
          Add key
        </button>
      </div>

      <div className="settings__banner">
        <InfoIcon size={16} />
        <span>
          Keys are stored only in this browser and sent directly to the provider you select. Schema
          Studio never receives or proxies them.
        </span>
      </div>

      {anyKey ? (
        <div className="settings__key-list">
          {configured.map((id) => {
            const state = keyFor(id);
            const isActive = id === provider;
            // A non-secret credential (a local endpoint URL) is shown in full; secrets stay masked.
            const { secret, noun } = PROVIDERS[id].credential;
            return (
              <div className="settings__key-card" key={id}>
                <div className="settings__key-row">
                  <span className="settings__key-tile" aria-hidden>
                    <SparkleIcon size={18} />
                  </span>
                  <div className="settings__key-body">
                    <div className="settings__key-name">
                      {PROVIDERS[id].label}
                      {isActive ? (
                        <span className="settings__pill settings__pill--active">
                          <span className="settings__pill-dot" />
                          Active
                        </span>
                      ) : null}
                    </div>
                    <div className="settings__key-value">
                      {secret ? maskKey(state.apiKey) : state.apiKey}
                    </div>
                    <div className="settings__key-meta">
                      {state.remember ? "Saved on this device" : "In memory · this session only"}
                    </div>
                    <label className="settings__remember">
                      <input
                        type="checkbox"
                        checked={state.remember}
                        onChange={(event) => setRemember(id, event.target.checked)}
                      />
                      Remember this {noun} on this device
                    </label>
                  </div>
                  <div className="settings__key-actions">
                    <button
                      type="button"
                      className="settings__icon-btn settings__icon-btn--danger"
                      onClick={() => {
                        setRemember(id, false);
                        setApiKey(id, "");
                      }}
                      aria-label={`Remove ${PROVIDERS[id].label} key`}
                      title="Remove key"
                    >
                      <TrashIcon size={16} />
                    </button>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      ) : (
        <div className="settings__empty">
          <span className="settings__empty-icon" aria-hidden>
            <KeyIcon size={20} />
          </span>
          <p className="settings__empty-title">No keys yet</p>
          <p className="settings__empty-body">
            Add an API key from any supported provider to enable Copilot. It stays in this browser
            and is used to call the provider directly.
          </p>
          <button type="button" className="settings__btn settings__btn--primary" onClick={onAddKey}>
            <PlusIcon size={16} />
            Add key
          </button>
        </div>
      )}

      <h2 className="settings__section-heading">Model</h2>
      <p className="settings__field-label">
        The model used for Copilot, suggestion ranking, and the initial-schema draft. Choosing a
        model also selects its provider.
        {modelsLoading ? " Loading your available models…" : ""}
      </p>
      <div className="settings__field-row">
        <label className="settings__field settings__field--model">
          <span className="settings__field-name">Model</span>
          <select
            className="settings__select"
            value={currentValue}
            onChange={(event) => chooseModel(event.target.value)}
          >
            {PROVIDER_IDS.map((id) => {
              const options = allModels.filter((candidate) => candidate.provider === id);
              if (options.length === 0) {
                return null;
              }
              return (
                <optgroup key={id} label={PROVIDERS[id].label}>
                  {options.map((option) => {
                    const value = encodeProviderModel(id, option.id);
                    return (
                      <option key={value} value={value}>
                        {option.displayName}
                      </option>
                    );
                  })}
                </optgroup>
              );
            })}
          </select>
        </label>
        <label className="settings__field">
          <span className="settings__field-name">Context</span>
          {/* Display-only — the window is fixed by the model, not a separate request parameter. */}
          <select className="settings__select" disabled aria-label="Model context window">
            <option>{formatContext(selectedModel?.maxInputTokens)}</option>
          </select>
        </label>
      </div>
      <p className="settings__hint">
        {anyKey
          ? "Pulled live from your keys’ available models, with current models as a fallback."
          : "Add a key to load the exact models it can access. The current models are shown until then."}
      </p>

      <h2 className="settings__section-heading">Target database</h2>
      <p className="settings__field-label">
        The stack Copilot models toward. It proposes column types, keys, and relationships in this
        target’s vocabulary and idioms so they round-trip through the export.
      </p>
      <div className="settings__field-row">
        <label className="settings__field settings__field--model">
          <span className="settings__field-name">Target</span>
          <select
            className="settings__select"
            value={target}
            onChange={(event) => setTarget(event.target.value as TargetId)}
          >
            {TargetIdSchema.options.map((id) => (
              <option key={id} value={id}>
                {TARGET_PROFILES[id].label}
              </option>
            ))}
          </select>
        </label>
      </div>
      <p className="settings__hint">
        {`Copilot warns about ${TARGET_PROFILES[target].label}-specific pitfalls — e.g. keeping leading-zero identifiers as text so joins don’t break.`}
      </p>

      <h2 className="settings__section-heading">AI-ranked suggestions</h2>
      <label className="settings__remember">
        <input
          type="checkbox"
          checked={rerank}
          disabled={!activeReady}
          onChange={(event) => setRerank(event.target.checked)}
        />
        Use AI to reorder and explain content-aware suggestions (makes a billable call to your
        provider when the suggestion set changes). Detectors still produce the suggestions — this
        only ranks them.
      </label>

      <h2 className="settings__section-heading">Initial schema draft</h2>
      <label className="settings__remember">
        <input
          type="checkbox"
          checked={autoDraft}
          disabled={!activeReady}
          onChange={(event) => setAutoDraft(event.target.checked)}
        />
        When you create a project, have AI draft an initial schema from your files and description
        (makes a billable call to your provider). The draft appears as a ghost proposal on the
        canvas — review and Accept or Discard it before anything is applied.
      </label>
    </div>
  );
}

const THEMES: Array<{ id: Theme; label: string; icon: ReactNode }> = [
  { id: "light", label: "Light", icon: <SunIcon size={15} /> },
  { id: "dark", label: "Dark", icon: <MoonIcon size={15} /> },
  { id: "system", label: "System", icon: <MonitorIcon size={15} /> },
];

function AppearanceSection() {
  const { theme, setTheme } = useThemeContext();

  return (
    <div className="settings__pane">
      <div className="settings__page-header">
        <div>
          <h1 className="settings__title">Appearance</h1>
          <p className="settings__subtitle">How Schema Studio looks on this device.</p>
        </div>
      </div>

      <h2 className="settings__section-heading">Theme</h2>
      <p className="settings__field-label">Choose light, dark, or follow your system setting.</p>
      <div className="settings__segments" role="group" aria-label="Theme">
        {THEMES.map((item) => {
          const selected = item.id === theme;
          return (
            <button
              key={item.id}
              type="button"
              className={`settings__segment${selected ? " is-selected" : ""}`}
              aria-pressed={selected}
              onClick={() => setTheme(item.id)}
            >
              {item.icon}
              {item.label}
            </button>
          );
        })}
      </div>
      <p className="settings__hint">Changes apply immediately and are saved to this browser.</p>
    </div>
  );
}
