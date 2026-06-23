import { useMemo, useState } from "react";

import type { AiProvider } from "@schema-studio/core";

import { AnthropicBrowserProvider } from "./ai/AnthropicBrowserProvider";
import { SourcesPanel } from "./sources";
import "./App.css";
import { CanvasPanel } from "./canvas/index.js";

function CopilotPanel({
  apiKey,
  onApiKeyChange,
  provider,
}: {
  apiKey: string;
  onApiKeyChange: (value: string) => void;
  provider: AiProvider | null;
}) {
  const [message, setMessage] = useState("");
  const [reply, setReply] = useState<string | null>(null);

  const handleSend = async () => {
    if (!provider || !message.trim()) {
      return;
    }

    const result = await provider.propose({ tables: [], relationships: [] }, [], message);
    setReply(result.reply);
  };

  return (
    <section className="panel">
      <header className="panel-header">Copilot</header>
      <div className="panel-body">
        <div className="copilot-key">
          <label htmlFor="anthropic-key">Anthropic API key</label>
          <input
            id="anthropic-key"
            type="password"
            placeholder="sk-ant-..."
            value={apiKey}
            onChange={(event) => onApiKeyChange(event.target.value)}
            autoComplete="off"
          />
        </div>
        <textarea
          rows={4}
          placeholder="Ask the copilot about your schema..."
          value={message}
          onChange={(event) => setMessage(event.target.value)}
          style={{ width: "100%", marginBottom: 12 }}
        />
        <button type="button" onClick={() => void handleSend()} disabled={!provider}>
          Send
        </button>
        {reply ? <p style={{ marginTop: 16 }}>{reply}</p> : null}
        {!provider ? (
          <p className="copilot-placeholder" style={{ marginTop: 12 }}>
            Enter an API key to enable the copilot.
          </p>
        ) : null}
      </div>
    </section>
  );
}

export function App() {
  const [apiKey, setApiKey] = useState("");

  const provider = useMemo(() => {
    if (!apiKey.trim()) {
      return null;
    }

    return new AnthropicBrowserProvider(apiKey.trim());
  }, [apiKey]);

  return (
    <div className="app-shell">
      <SourcesPanel />
      <CanvasPanel />
      <CopilotPanel apiKey={apiKey} onApiKeyChange={setApiKey} provider={provider} />
    </div>
  );
}
