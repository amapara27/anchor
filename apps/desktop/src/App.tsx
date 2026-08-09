import { useEffect, useState } from "react";
import type { ModelsTab, Tab } from "./types";
import { ModelsProvider } from "./lib/useModels";
import { ChatProvider } from "./lib/useChat";
import { TitleBar } from "./components/TitleBar";
import { Sidebar } from "./components/Sidebar";
import { ChatWorkspace } from "./components/ChatWorkspace";
import { ModelsHub } from "./components/ModelsHub";
import { StoragePage } from "./components/StoragePage";
import { BenchmarksPage } from "./components/BenchmarksPage";
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
    // Both providers sit above the tab-keyed <main>, which unmounts its whole
    // subtree on a tab switch: pages share one model sync + download map, and
    // the open conversation survives leaving Chat and coming back.
    <ModelsProvider>
      <ChatProvider>
        <div className="flex h-dvh flex-col">
          <TitleBar onOpenPalette={() => setPaletteOpen(true)} />
          <div className="flex min-h-0 flex-1">
            <Sidebar active={tab} onSelect={setTab} />
            {/* Chat and Models own their full height (internal scroll + side
                panes); the flat pages scroll inside a padded content column. */}
            {tab === "chat" ? (
              <main key={tab} className="animate-fade-in flex min-w-0 flex-1">
                <ChatWorkspace />
              </main>
            ) : tab === "models" ? (
              <main key={tab} className="animate-fade-in flex min-w-0 flex-1 overflow-hidden">
                <ModelsHub openModel={openModel} initialTab={modelsTab} />
              </main>
            ) : (
              <main key={tab} className="scrollbar-slim animate-fade-in min-w-0 flex-1 overflow-y-auto">
                <div className="mx-auto flex w-full max-w-[1180px] flex-col gap-[18px] px-7 pb-9 pt-6">
                  {tab === "storage" && <StoragePage />}
                  {tab === "benchmarks" && <BenchmarksPage />}
                  {tab === "settings" && <SettingsPage />}
                </div>
              </main>
            )}
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
      </ChatProvider>
    </ModelsProvider>
  );
}
