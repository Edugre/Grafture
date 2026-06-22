import type { Node, NodeProps } from "@xyflow/react";
import { Background, Controls, MiniMap, ReactFlow } from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { useMemo, useState } from "react";

import type { AiProvider } from "@schema-studio/core";

import { AnthropicBrowserProvider } from "./ai/AnthropicBrowserProvider";
import "./App.css";

type TableNodeData = {
  label: string;
  fields: Array<{ name: string; type: string }>;
};

type TableNode = Node<TableNodeData, "table">;

function TableNodeComponent({ data }: NodeProps<TableNode>) {
  return (
    <div className="table-node">
      <div className="table-node__title">{data.label}</div>
      {data.fields.map((field) => (
        <div key={field.name} className="table-node__field">
          <span>{field.name}</span>
          <span className="table-node__type">{field.type}</span>
        </div>
      ))}
    </div>
  );
}

const nodeTypes = {
  table: TableNodeComponent,
};

const initialNodes: TableNode[] = [
  {
    id: "users",
    type: "table",
    position: { x: 120, y: 80 },
    data: {
      label: "users",
      fields: [
        { name: "id", type: "uuid" },
        { name: "email", type: "text" },
      ],
    },
  },
];

function SourcesPanel() {
  return (
    <section className="panel">
      <header className="panel-header">Sources</header>
      <div className="panel-body">
        <p className="sources-placeholder">
          Drop CSV, Excel, or JSON files here. Parsing will be wired up in a later task.
        </p>
      </div>
    </section>
  );
}

function CanvasPanel() {
  const nodes = useMemo(() => initialNodes, []);

  return (
    <section className="panel canvas-panel">
      <header className="panel-header">Canvas</header>
      <div className="panel-body">
        <ReactFlow className="schema-canvas" nodes={nodes} edges={[]} nodeTypes={nodeTypes} fitView>
          <Background />
          <Controls />
          <MiniMap />
        </ReactFlow>
      </div>
    </section>
  );
}

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
