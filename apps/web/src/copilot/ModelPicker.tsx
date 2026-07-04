import { useEffect, useRef, useState } from "react";

import { setModelPreference, useModelPreference } from "../ai/modelPreference.js";
import { useProviderPreference } from "../ai/providerPreference.js";
import { PROVIDERS, PROVIDER_IDS, type ProviderId } from "../ai/providers.js";
import { useAllModels } from "../ai/useModels.js";
import { useApiKeyContext } from "./ApiKeyContext.js";
import { CheckIcon, ChevronDownIcon, LockIcon, ServerIcon } from "../ui/icons.js";
import "./ModelPicker.css";

/**
 * A compact, Cursor-style model selector for the chat composer. Lists each provider's models plus a
 * Local option. The model set comes from {@link useAllModels} — the same live+catalog source the
 * Settings dropdown uses — so it surfaces the models a key can actually access and stays in sync
 * rather than drifting from a hand-maintained shortlist. A model whose provider has no saved key is
 * shown disabled; Local is always disabled until a local runtime exists. Picking a model both sets
 * that provider's model and makes the provider active, so the copilot switches immediately.
 */
export function ModelPicker({ onConnect }: { onConnect?: () => void }) {
  const { provider, setProvider } = useProviderPreference();
  const { model } = useModelPreference(provider);
  const { keyFor } = useApiKeyContext();
  const { models } = useAllModels();
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  // Close on outside click or Escape.
  useEffect(() => {
    if (!open) {
      return;
    }
    const onPointerDown = (event: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(event.target as Node)) {
        setOpen(false);
      }
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpen(false);
      }
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  const hasKey = (id: ProviderId) => keyFor(id).apiKey.trim().length > 0;

  // Label for the current selection, from the resolved model list (or the raw id as a fallback).
  const currentModel = models.find((entry) => entry.provider === provider && entry.id === model);
  const currentLabel = currentModel?.displayName ?? model;

  const select = (providerId: ProviderId, id: string) => {
    setModelPreference(providerId, id);
    setProvider(providerId);
    setOpen(false);
  };

  return (
    <div className="model-picker" ref={rootRef}>
      <button
        type="button"
        className="model-picker__toggle"
        onClick={() => setOpen((value) => !value)}
        aria-haspopup="listbox"
        aria-expanded={open}
        title="Choose model"
      >
        <span className="model-picker__current">{currentLabel}</span>
        <ChevronDownIcon size={13} className="model-picker__chevron" />
      </button>

      {open ? (
        <div className="model-picker__menu" role="listbox" aria-label="Model">
          {PROVIDER_IDS.map((id) => {
            const meta = PROVIDERS[id];
            const enabled = hasKey(id);
            const options = models.filter((entry) => entry.provider === id);
            if (options.length === 0) {
              return null;
            }
            return (
              <div className="model-picker__group" key={id}>
                <div className="model-picker__group-head">
                  <span className="model-picker__group-label">{meta.label}</span>
                  {!enabled ? (
                    <button
                      type="button"
                      className="model-picker__connect"
                      onClick={() => {
                        setOpen(false);
                        onConnect?.();
                      }}
                    >
                      <LockIcon size={11} />
                      Add key
                    </button>
                  ) : null}
                </div>
                {options.map((entry) => {
                  const isActive = id === provider && entry.id === model;
                  return (
                    <button
                      key={entry.id}
                      type="button"
                      role="option"
                      aria-selected={isActive}
                      className={`model-picker__option${isActive ? " is-active" : ""}`}
                      disabled={!enabled}
                      onClick={() => select(id, entry.id)}
                    >
                      <span className="model-picker__option-name">{entry.displayName}</span>
                      {isActive ? <CheckIcon size={14} className="model-picker__check" /> : null}
                    </button>
                  );
                })}
              </div>
            );
          })}

          {/* Local runtime — not yet implemented, always shown disabled. */}
          <div className="model-picker__group">
            <div className="model-picker__group-head">
              <span className="model-picker__group-label">Local</span>
              <span className="model-picker__soon">Soon</span>
            </div>
            <button
              type="button"
              role="option"
              aria-selected={false}
              className="model-picker__option"
              disabled
              title="Local models are coming soon"
            >
              <span className="model-picker__option-name">
                <ServerIcon size={13} className="model-picker__option-icon" />
                Local model
              </span>
            </button>
          </div>
        </div>
      ) : null}
    </div>
  );
}
