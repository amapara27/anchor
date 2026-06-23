import { useState } from "react";
import type { Tab } from "./types";
import { TitleBar } from "./components/TitleBar";
import { Sidebar } from "./components/Sidebar";
import { HomePage } from "./components/HomePage";
import { ModelLibrary } from "./components/ModelLibrary";
import { ModelComparison } from "./components/ModelComparison";
import { WorkflowLibrary } from "./components/WorkflowLibrary";

export default function App() {
  const [tab, setTab] = useState<Tab>("home");

  return (
    <div className="flex h-dvh flex-col">
      <TitleBar active={tab} />
      <div className="flex min-h-0 flex-1">
        <Sidebar active={tab} onSelect={setTab} />
        <main className="scrollbar-slim min-w-0 flex-1 overflow-y-auto">
          {/* key remounts on tab switch so the page-enter animation replays */}
          <div key={tab} className="animate-fade-in mx-auto max-w-7xl px-6 py-9 lg:px-8">
            {tab === "home" && <HomePage onNavigate={setTab} />}
            {tab === "models" && <ModelLibrary />}
            {tab === "comparison" && <ModelComparison />}
            {tab === "workflows" && <WorkflowLibrary />}
          </div>
        </main>
      </div>
    </div>
  );
}
