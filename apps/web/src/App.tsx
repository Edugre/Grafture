import { useState } from "react";

import { ByoKeyPage } from "./byokey/ByoKeyPage.js";
import { CanvasPanel } from "./canvas/index.js";
import { ApiKeyProvider } from "./copilot/ApiKeyContext.js";
import { CopilotPanel, type CopilotTab } from "./copilot/index.js";
import { SettingsPage } from "./settings/SettingsPage.js";
import { SourcesPanel } from "./sources";
import { SuggestionsToast } from "./suggest/index.js";
import { ThemeProvider } from "./theme/ThemeContext.js";
import { TopBar } from "./topbar/TopBar.js";
import "./App.css";

type View = "dashboard" | "settings" | "byok";

export function App() {
  const [view, setView] = useState<View>("dashboard");
  // Where the BYO-key page returns to when closed (it's opened from both the
  // Copilot CTA and the Settings → API keys page).
  const [byokReturn, setByokReturn] = useState<View>("dashboard");
  // Which Copilot pane tab is active. Lifted here so the suggestions toast's
  // "View suggestions" CTA can route the pane to the Suggestions tab.
  const [copilotTab, setCopilotTab] = useState<CopilotTab>("chat");
  // The expanded suggestion card (single-open accordion), shared with the canvas so it can
  // preview the active suggestion. Cleared when leaving the Suggestions tab.
  const [activeSuggestionId, setActiveSuggestionId] = useState<string | null>(null);

  const openByok = (from: View) => {
    setByokReturn(from);
    setView("byok");
  };

  const changeCopilotTab = (next: CopilotTab) => {
    setCopilotTab(next);
    if (next !== "suggestions") {
      setActiveSuggestionId(null);
    }
  };

  return (
    <ThemeProvider>
      <ApiKeyProvider>
        {view === "byok" ? (
          <ByoKeyPage onClose={() => setView(byokReturn)} />
        ) : view === "settings" ? (
          <SettingsPage onBack={() => setView("dashboard")} onAddKey={() => openByok("settings")} />
        ) : (
          <div className="app-root">
            <TopBar onOpenSettings={() => setView("settings")} />
            <div className="app-shell">
              <SourcesPanel />
              <CanvasPanel
                activeSuggestionId={copilotTab === "suggestions" ? activeSuggestionId : null}
              />
              <CopilotPanel
                onConnect={() => openByok("dashboard")}
                tab={copilotTab}
                onTabChange={changeCopilotTab}
                activeSuggestionId={activeSuggestionId}
                onActivateSuggestion={setActiveSuggestionId}
              />
            </div>
            <SuggestionsToast onView={() => changeCopilotTab("suggestions")} />
          </div>
        )}
      </ApiKeyProvider>
    </ThemeProvider>
  );
}
