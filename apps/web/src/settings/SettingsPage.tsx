import { useState, type ReactNode } from "react";

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

function ApiKeysSection({ onAddKey }: { onAddKey: () => void }) {
  const { apiKey, remember, setApiKey, setRemember } = useApiKeyContext();
  const { enabled: rerank, setEnabled: setRerank } = useRerankPreference();
  const { enabled: autoDraft, setEnabled: setAutoDraft } = useAutoDraftPreference();

  const hasKey = apiKey.trim().length > 0;

  const handleRemove = () => {
    setRemember(false);
    setApiKey("");
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

      {hasKey ? (
        <div className="settings__key-card">
          <div className="settings__key-row">
            <span className="settings__key-tile" aria-hidden>
              <SparkleIcon size={18} />
            </span>
            <div className="settings__key-body">
              <div className="settings__key-name">
                Anthropic
                <span className="settings__pill settings__pill--active">
                  <span className="settings__pill-dot" />
                  Active
                </span>
              </div>
              <div className="settings__key-value">{maskKey(apiKey)}</div>
              <div className="settings__key-meta">
                {remember ? "Saved on this device" : "In memory · this session only"} · Claude
              </div>
            </div>
            <div className="settings__key-actions">
              <button
                type="button"
                className="settings__icon-btn settings__icon-btn--danger"
                onClick={handleRemove}
                aria-label="Remove key"
                title="Remove key"
              >
                <TrashIcon size={16} />
              </button>
            </div>
          </div>
        </div>
      ) : (
        <div className="settings__empty">
          <span className="settings__empty-icon" aria-hidden>
            <KeyIcon size={20} />
          </span>
          <p className="settings__empty-title">No keys yet</p>
          <p className="settings__empty-body">
            Add an Anthropic API key to enable Copilot. It stays in this browser and is used to call
            the provider directly.
          </p>
          <button type="button" className="settings__btn settings__btn--primary" onClick={onAddKey}>
            <PlusIcon size={16} />
            Add key
          </button>
        </div>
      )}

      <label className="settings__remember">
        <input
          type="checkbox"
          checked={remember}
          disabled={!hasKey}
          onChange={(event) => setRemember(event.target.checked)}
        />
        Remember this key on this device (otherwise it is kept in memory for this session only)
      </label>

      <h2 className="settings__section-heading">AI-ranked suggestions</h2>
      <label className="settings__remember">
        <input
          type="checkbox"
          checked={rerank}
          disabled={!hasKey}
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
          disabled={!hasKey}
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
