import { useEffect, useState } from "react";
import type { Tab } from "./types";
import { TitleBar } from "./components/TitleBar";
import { Sidebar } from "./components/Sidebar";
import { HomePage } from "./components/HomePage";
import { SearchPage } from "./components/SearchPage";
import { ModelLibrary } from "./components/ModelLibrary";
import { ModelComparison } from "./components/ModelComparison";
import { DiskPage } from "./components/DiskPage";
import { WorkflowLibrary } from "./components/WorkflowLibrary";
import { CommandPalette } from "./components/CommandPalette";

export default function App() {
  const [tab, setTab] = useState<Tab>("home");
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

  return (
    <div className="flex h-dvh flex-col">
      <TitleBar active={tab} onOpenPalette={() => setPaletteOpen(true)} />
      <div className="flex min-h-0 flex-1">
        <Sidebar active={tab} onSelect={setTab} />
        <main className="scrollbar-slim min-w-0 flex-1 overflow-y-auto">
          {/* key remounts on tab switch so the page-enter animation replays */}
          <div key={tab} className="animate-fade-in mx-auto max-w-[1440px] px-6 py-9 lg:px-8">
            {tab === "home" && <HomePage onNavigate={setTab} />}
            {tab === "search" && <SearchPage />}
            {tab === "models" && <ModelLibrary openModel={openModel} />}
            {tab === "comparison" && <ModelComparison />}
            {tab === "disk" && <DiskPage />}
            {tab === "workflows" && <WorkflowLibrary />}
          </div>
        </main>
      </div>

      <CommandPalette
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        onNavigate={setTab}
        onJumpToModel={(id) => {
          setTab("models");
          setOpenModel({ id, nonce: Date.now() });
        }}
      />
    </div>
  );
}
