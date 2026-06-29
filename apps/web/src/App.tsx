import { useState } from "react";

import { ByoKeyPage } from "./byokey/ByoKeyPage.js";
import { CanvasPanel } from "./canvas/index.js";
import { ApiKeyProvider } from "./copilot/ApiKeyContext.js";
import { CopilotPanel, type CopilotTab } from "./copilot/index.js";
import { HomePage } from "./home/index.js";
import type { CopilotKickoff } from "./copilot/index.js";
import { ProjectsProvider } from "./persistence/index.js";
import { SettingsPage } from "./settings/SettingsPage.js";
import { SourcesPanel } from "./sources";
import { SuggestionsToast } from "./suggest/index.js";
import { ThemeProvider } from "./theme/ThemeContext.js";
import { TopBar } from "./topbar/TopBar.js";
import "./App.css";

type View = "home" | "dashboard" | "settings" | "byok";

export function App() {
  // The app opens on the Home/Projects screen; picking or creating a project enters the editor.
  const [view, setView] = useState<View>("home");
  // Where the BYO-key page returns to when closed (it's opened from both the
  // Copilot CTA and the Settings → API keys page).
  const [byokReturn, setByokReturn] = useState<View>("dashboard");
  // Where the Settings page returns to — Home or the editor, depending on where it was opened.
  const [settingsReturn, setSettingsReturn] = useState<View>("dashboard");
  // Which Copilot pane tab is active. Lifted here so the suggestions toast's
  // "View suggestions" CTA can route the pane to the Suggestions tab.
  const [copilotTab, setCopilotTab] = useState<CopilotTab>("chat");
  // The expanded suggestion card (single-open accordion), shared with the canvas so it can
  // preview the active suggestion. Cleared when leaving the Suggestions tab.
  const [activeSuggestionId, setActiveSuggestionId] = useState<string | null>(null);
  // Side-panel collapse: collapsed panels shrink to a thin rail so the canvas gets more room.
  const [sourcesCollapsed, setSourcesCollapsed] = useState(false);
  const [copilotCollapsed, setCopilotCollapsed] = useState(false);
  // Seeds the Copilot when entering the editor from the New Project modal's "Derive schema". Carries
  // the framed prompt and whether to auto-draft a ghost schema. Reset on every other entry.
  const [copilotKickoff, setCopilotKickoff] = useState<CopilotKickoff | undefined>(undefined);

  const enterEditor = (kickoff?: CopilotKickoff) => {
    setCopilotKickoff(kickoff);
    setView("dashboard");
  };

  const openByok = (from: View) => {
    setByokReturn(from);
    setView("byok");
  };

  const openSettings = (from: View) => {
    setSettingsReturn(from);
    setView("settings");
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
        <ProjectsProvider>
          {view === "byok" ? (
            <ByoKeyPage onClose={() => setView(byokReturn)} />
          ) : view === "settings" ? (
            <SettingsPage
              onBack={() => setView(settingsReturn)}
              onAddKey={() => openByok("settings")}
            />
          ) : view === "home" ? (
            <HomePage onOpenSettings={() => openSettings("home")} onEnterEditor={enterEditor} />
          ) : (
            <div className="app-root">
              <TopBar
                onOpenHome={() => setView("home")}
                onOpenSettings={() => openSettings("dashboard")}
              />
              <div
                className="app-shell"
                style={{
                  gridTemplateColumns: `${sourcesCollapsed ? "48px" : "288px"} 1fr ${
                    copilotCollapsed ? "48px" : "372px"
                  }`,
                }}
              >
                <SourcesPanel
                  collapsed={sourcesCollapsed}
                  onToggleCollapse={() => setSourcesCollapsed((value) => !value)}
                />
                <CanvasPanel
                  activeSuggestionId={copilotTab === "suggestions" ? activeSuggestionId : null}
                  onBack={() => setView("home")}
                />
                <CopilotPanel
                  onConnect={() => openByok("dashboard")}
                  kickoff={copilotKickoff}
                  tab={copilotTab}
                  onTabChange={changeCopilotTab}
                  activeSuggestionId={activeSuggestionId}
                  onActivateSuggestion={setActiveSuggestionId}
                  collapsed={copilotCollapsed}
                  onToggleCollapse={() => setCopilotCollapsed((value) => !value)}
                />
              </div>
              <SuggestionsToast onView={() => changeCopilotTab("suggestions")} />
            </div>
          )}
        </ProjectsProvider>
      </ApiKeyProvider>
    </ThemeProvider>
  );
}
