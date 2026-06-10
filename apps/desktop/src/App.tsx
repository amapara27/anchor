import { useState } from "react";
import type { Tab } from "./types";
import { Sidebar } from "./components/Sidebar";
import { HomePage } from "./components/HomePage";
import { ModelLibrary } from "./components/ModelLibrary";
import { WorkflowLibrary } from "./components/WorkflowLibrary";

export default function App() {
  const [tab, setTab] = useState<Tab>("home");

  return (
    <div className="flex min-h-dvh">
      <Sidebar active={tab} onSelect={setTab} />
      <main className="scrollbar-slim min-w-0 flex-1 overflow-y-auto">
        <div className="mx-auto max-w-7xl px-6 py-10 lg:px-8">
          {tab === "home" && <HomePage onNavigate={setTab} />}
          {tab === "models" && <ModelLibrary />}
          {tab === "workflows" && <WorkflowLibrary />}
        </div>
      </main>
    </div>
  );
}
