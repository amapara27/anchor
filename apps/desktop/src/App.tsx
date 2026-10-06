import { invoke } from "@tauri-apps/api/core";
import { useEffect, useState } from "react";
import type { ModelsTab, Tab, Preset } from "./types";
import { ModelsProvider, useModels } from "./lib/useModels";
import { ChatProvider, useChat } from "./lib/useChat";
import { TitleBar } from "./components/TitleBar";
import { ChatWorkspace } from "./components/ChatWorkspace";
import { ModelsHub } from "./components/ModelsHub";
import { StoragePage } from "./components/StoragePage";
import { BenchmarksPage } from "./components/BenchmarksPage";
import { SettingsPage } from "./components/SettingsPage";
import { CommandPalette } from "./components/CommandPalette";
import { UpdateBanner } from "./components/UpdateBanner";

export default function App() {
  return <ModelsProvider><ChatProvider><Workspace /></ChatProvider></ModelsProvider>;
}

function Workspace() {
  const [tab, setTab] = useState<Tab>("models");
  const [visited, setVisited] = useState<Set<Tab>>(new Set(["models"]));
  const [modelsTab, setModelsTab] = useState<ModelsTab>("installed");
  const [comparisonBusy, setComparisonBusy] = useState(false);
  const [benchmarkBusy, setBenchmarkBusy] = useState(false);
  const [jobError, setJobError] = useState("");
  const stopJob = (command: string) => { void invoke(command).catch(e=>setJobError(String(e))); };
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [openModel, setOpenModel] = useState<{ id: string; nonce: number } | null>(null);
  const [benchModel, setBenchModel] = useState<{ id: string; nonce: number } | null>(null);
  const { downloads, cancelDownload } = useModels();
  const { create, runningIds, stop, conversations } = useChat();
  const navigate = (next: Tab, sub?: ModelsTab) => {
    setVisited(v => new Set([...v, next]));
    setTab(next);
    if (sub) setModelsTab(sub);
  };
  useEffect(() => {
    const key = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault(); setPaletteOpen(o => !o);
      }
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, []);
  const tryModel = async (id: string, context: number) => {
    const presets = await invoke<Preset[]>("list_presets");
    const defaults = presets.find(p=>p.id === "default");
    const preset = {...defaults, id: "trial-context-" + context, name: "Trial · " + context / 1024 + "K", system: defaults?.system ?? null, temperature: defaults?.temperature ?? null, top_p: defaults?.top_p ?? null, model: null, num_ctx: context, created_ms: Date.now()};
    await invoke("save_preset", {preset});
    window.dispatchEvent(new Event("anchor:presets"));
    await create(id, preset.id);
    navigate("chat");
  };
  return <div className="flex h-dvh flex-col">
    <TitleBar onOpenPalette={() => setPaletteOpen(true)} />
    <UpdateBanner />
    <nav aria-label="Tools" className="flex shrink-0 flex-wrap items-center gap-1 border-b border-hair bg-chrome px-5 py-2">
      {([["models", "Models"], ["benchmarks", "Benchmarks"]] as [Tab, string][]).map(([id, label]) =>
        <button key={id} onClick={() => navigate(id)} aria-current={tab === id ? "page" : undefined}
          className={"rounded-lg px-3 py-1.5 text-sm transition-colors focus-visible:outline-2 focus-visible:outline-accent " + (tab === id ? "bg-accent-soft text-accent-text" : "text-fg-muted hover:bg-inset")}>
          {label}
        </button>)}
      <details className="relative ml-auto"><summary className="cursor-pointer rounded-lg px-3 py-1.5 text-sm text-fg-muted">More tools</summary>
        <div className="absolute right-0 top-full z-40 mt-2 flex w-48 flex-col rounded-xl border border-hair bg-surface p-2 shadow-overlay">
          {([["chat", "Try & history"], ["storage", "Manage storage"], ["settings", "Settings"]] as [Tab,string][]).map(([id,label])=><button key={id} className="rounded-lg px-3 py-2 text-left text-sm hover:bg-inset" onClick={e=>{navigate(id); e.currentTarget.closest("details")?.removeAttribute("open");}}>{label}</button>)}
        </div>
      </details>
    </nav>
    {/* Mounted once per tool: navigation never discards a running job or draft. */}
    {Array.from(visited).map(page => <main key={page} hidden={tab !== page} className={tab !== page ? "hidden" : "flex min-h-0 flex-1 overflow-hidden"}>
      {page === "models" ? <ModelsHub openModel={openModel} initialTab={modelsTab} onTry={tryModel} onCompareBusy={setComparisonBusy} onBenchmark={id => { setBenchModel({id, nonce: Date.now()}); navigate("benchmarks"); }} /> :
       page === "chat" ? <ChatWorkspace /> :
       <div className="scrollbar-slim min-w-0 flex-1 overflow-y-auto"><div className="mx-auto flex max-w-[1100px] flex-col gap-5 px-6 py-6">
         {page === "storage" && <StoragePage />}
         {page === "benchmarks" && <BenchmarksPage openModel={benchModel} onBusy={setBenchmarkBusy} />}
         {page === "settings" && <SettingsPage />}
       </div></div>}
    </main>)}
    {(Object.keys(downloads).length > 0 || runningIds.size > 0 || comparisonBusy || benchmarkBusy || jobError) && <div role="status" aria-label="Activity" className="flex shrink-0 flex-wrap gap-4 border-t border-hair bg-chrome px-5 py-2 text-xs">
      {comparisonBusy && <span>Comparison running <button onClick={() => stopJob("stop_comparison")} className="text-accent-text">Stop comparison</button></span>}
      {benchmarkBusy && <span>Benchmark running <button onClick={() => stopJob("stop_benchmark")} className="text-accent-text">Stop benchmark</button></span>}
      {jobError && <span role="alert">{jobError}<button onClick={()=>setJobError("")}>Dismiss</button></span>}
      {Object.values(downloads).map(d => <span key={d.modelId} className="flex items-center gap-2">{d.modelId}: {d.error ?? d.status}
        {d.status === "downloading" && <button onClick={() => cancelDownload(d.modelId)} className="text-accent-text">Cancel download</button>}</span>)}
      {Array.from(runningIds).map(id => <span key={id} className="flex items-center gap-2">Trying {conversations.find(c => c.id === id)?.model}
        <button onClick={() => stop(id)} className="text-accent-text">Stop trial</button></span>)}
    </div>}
    <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} onNavigate={navigate} onJumpToModel={id => {
      navigate("models", "installed"); setOpenModel({ id, nonce: Date.now() });
    }} />
  </div>;
}
