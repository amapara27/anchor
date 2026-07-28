import { useEffect, useState } from "react";
import type { ModelsTab, Tab } from "./types";
import { ModelsProvider } from "./lib/useModels";
import { TitleBar } from "./components/TitleBar";
import { Sidebar } from "./components/Sidebar";
import { ChatPlaceholder } from "./components/ChatPlaceholder";
import { WorkflowLibrary } from "./components/WorkflowLibrary";
import { ModelsHub } from "./components/ModelsHub";
import { SettingsPage } from "./components/SettingsPage";
import { CommandPalette } from "./components/CommandPalette";

export default function App() {
  const [tab, setTab] = useState<Tab>("chat");
  const [modelsTab, setModelsTab] = useState<ModelsTab>("installed");
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [openModel, setOpenModel] = useState<{ id: string; nonce: number } | null>(null);

  // Global ⌘K / Ctrl+K toggles the command palette.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault();
        setPaletteOpen((o) => !o);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  // Navigate to a tab, optionally deep-linking a Models sub-view.
  const navigate = (next: Tab, sub?: ModelsTab) => {
    setTab(next);
    if (sub) setModelsTab(sub);
  };

  return (
    // One ModelsProvider above the tab-keyed div: pages share a single model
    // sync + download map, and tab switches don't refetch.
    <ModelsProvider>
      <div className="flex h-dvh flex-col">
        <TitleBar active={tab} onOpenPalette={() => setPaletteOpen(true)} />
        <div className="flex min-h-0 flex-1">
          <Sidebar active={tab} onSelect={setTab} />
          <main className="scrollbar-slim min-w-0 flex-1 overflow-y-auto">
            {/* key remounts on tab switch so the page-enter animation replays */}
            <div key={tab} className="animate-fade-in mx-auto max-w-[1440px] px-6 py-9 lg:px-8">
              {tab === "chat" && <ChatPlaceholder />}
              {tab === "agents" && <WorkflowLibrary />}
              {tab === "models" && <ModelsHub openModel={openModel} initialTab={modelsTab} />}
              {tab === "settings" && <SettingsPage />}
            </div>
          </main>
        </div>

        <CommandPalette
          open={paletteOpen}
          onClose={() => setPaletteOpen(false)}
          onNavigate={navigate}
          onJumpToModel={(id) => {
            navigate("models", "installed");
            setOpenModel({ id, nonce: Date.now() });
          }}
        />
      </div>
    </ModelsProvider>
  );
}
