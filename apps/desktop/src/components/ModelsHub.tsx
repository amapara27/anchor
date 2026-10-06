import { useEffect, useRef, useState } from "react";
import type { LibraryModel, ModelsTab } from "../types";
import { useModels } from "../lib/useModels";
import { useHardwareProfile } from "../lib/useHardwareProfile";
import { formatBytes } from "../lib/format";
import { hardwareHint } from "../lib/hint";
import { DEFAULT_CONTEXT } from "../lib/fit";
import { ModelDetailAside } from "./ModelDetailAside";
import { SearchPage } from "./SearchPage";
import { BrowsePage } from "./BrowsePage";
import { ModelComparison } from "./ModelComparison";
import { Tabs } from "./ui/Tabs";
import { ConfirmDialog } from "./ui/ConfirmDialog";

export function ModelsHub({openModel, initialTab = "installed", onTry, onBenchmark, onCompareBusy}: {
  openModel: {id: string; nonce: number} | null; initialTab?: ModelsTab;
  onCompareBusy?: (busy: boolean) => void;
  onTry: (id: string, context: number) => Promise<void>; onBenchmark: (id: string) => void;
}) {
  const {models, loading, error, downloads, reload, startDownload, removeModel} = useModels();
  const {profile} = useHardwareProfile();
  const [tab, setTab] = useState<ModelsTab>(initialTab);
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<LibraryModel | null>(null);
  const inspectorRef = useRef<HTMLElement>(null);
  const selectionTrigger = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (selected && tab !== "compare") {
      inspectorRef.current?.focus({preventScroll: true});
      inspectorRef.current?.scrollIntoView({block: "start"});
    }
  }, [selected?.id, tab]);
  const closeInspector = () => {
    setSelected(null);
    if (selectionTrigger.current?.isConnected) selectionTrigger.current.focus();
  };
  const [pendingRemove, setPendingRemove] = useState(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [findMode, setFindMode] = useState<"discover" | "browse">("discover");
  const [compared, setCompared] = useState(false);
  const [fitsOnly, setFitsOnly] = useState(false);
  useEffect(() => { setTab(initialTab); if (initialTab === "compare") setCompared(true); if (initialTab === "browse") setFindMode("browse"); }, [initialTab]);
  useEffect(() => { if (openModel) { setTab("installed"); setSelected(models.find(m => m.id === openModel.id) ?? null); } }, [openModel, models]);
  const installed = models.filter(m => m.status === "installed");
  const select = (id: string) => {
    selectionTrigger.current = document.activeElement as HTMLElement;
    setSelected(models.find(m => m.id === id) ?? null);
  };
  const hintFor = (m: LibraryModel) => hardwareHint({ id: m.id, params_b: m.spec.params_b, quant: m.spec.quant,
    contextTokens: m.spec.context_tokens || DEFAULT_CONTEXT, arch: m.arch, sizeBytes: m.size_bytes }, profile);
  const rows = installed.filter(m => (!query || (m.name + " " + m.id).toLowerCase().includes(query.toLowerCase())) && (!fitsOnly || hintFor(m).tier === "ok"));
  const active = selected ? models.find(m => m.id === selected.id) ?? selected : null;
  const switchTab = (next: ModelsTab) => { setTab(next); setSelected(null); if (next === "compare") setCompared(true); };
  return <div className="scrollbar-slim min-w-0 flex-1 overflow-y-auto">
    <div className="mx-auto flex max-w-[1100px] flex-col gap-5 px-6 py-6">
      <header className="flex flex-wrap items-center justify-between gap-3">
        <div><h1 className="text-2xl font-semibold">Models</h1><p className="mt-1 text-sm text-fg-muted">{profile?.chip ?? "Your Mac"}{profile?.memory_bytes ? " · " + formatBytes(profile.memory_bytes) + " RAM" : ""} · {installed.length} installed · {formatBytes(installed.reduce((sum,m) => sum + (m.size_bytes ?? 0),0))} on disk</p></div>
        <button onClick={() => switchTab("discover")} className="rounded-lg bg-accent px-4 py-2 text-sm font-medium text-accent-fg">Add model</button>
      </header>
      <div className="flex flex-wrap items-center gap-3">
        <Tabs ariaLabel="Models view" value={tab === "browse" ? "discover" : tab} onChange={switchTab} items={[{key:"installed",label:"Installed"},{key:"discover",label:"Find"},{key:"compare",label:"Compare"}]} />
        {tab === "installed" && <><input aria-label="Search installed models" placeholder="Search installed models…" value={query} onChange={e => setQuery(e.target.value)} className="min-w-0 flex-1 rounded-lg border border-hair bg-inset px-3 py-2 text-sm" />
          <button aria-pressed={fitsOnly} onClick={() => setFitsOnly(v=>!v)} className="rounded-lg border border-hair px-3 py-2 text-xs">Fits at 4K</button></>}
      </div>
      {(error || actionError) && <div role="alert" className="flex items-center gap-3 rounded-lg border border-hair p-3 text-sm"><span className="flex-1">{actionError ?? error}</span><button onClick={() => {setActionError(null); reload();}} className="text-accent-text">Retry</button></div>}
      {tab === "installed" && (loading ? <p role="status">Loading your models…</p> : installed.length === 0 ?
        <div className="py-12"><h2 className="text-lg font-medium">Choose your first local model</h2><p className="mt-2 text-sm text-fg-muted">Find a model for your task and check its memory fit before downloading.</p><button onClick={() => switchTab("discover")} className="mt-4 rounded-lg bg-accent px-4 py-2 text-sm text-accent-fg">Find a model</button></div> :
        <div aria-label="Installed model list" className="divide-y divide-hair border-y border-hair">
          {rows.map(m => {const hint=hintFor(m); return <button key={m.id} aria-label={"Inspect " + m.name} onClick={() => select(m.id)} className="grid w-full grid-cols-[minmax(180px,1fr)_90px_120px_140px] items-center gap-4 py-4 text-left hover:bg-inset focus-visible:outline-2 focus-visible:outline-accent">
            <span className="min-w-0"><span className="block truncate text-sm font-medium">{m.name}</span><span className="mt-1 block text-xs text-fg-muted">{m.spec.quant}</span></span>
            <span className="data text-xs text-fg-muted">{formatBytes(m.size_bytes)}</span><span className={"text-xs " + hint.tone}>{hint.label} at 4K</span>
            <span className="data text-right text-xs text-fg-muted">{hint.tps ? (hint.tps.source === "measured" ? "Measured " : "Estimated ") + hint.tpsLabel : "Speed unknown"}</span>
          </button>})}
          {rows.length === 0 && <p className="py-8 text-sm text-fg-muted">No models match these filters.</p>}
        </div>)}
      {(tab === "discover" || tab === "browse") && <div>
        <div className="mb-5 flex gap-3"><button aria-pressed={findMode === "discover"} onClick={() => setFindMode("discover")} className="text-sm text-accent-text">By task</button><button aria-pressed={findMode === "browse"} onClick={() => setFindMode("browse")} className="text-sm text-accent-text">Ollama library</button></div>
        {findMode === "discover" ? <SearchPage onSelect={select} /> : <BrowsePage onSelect={setSelected} selectedTag={selected?.id ?? null} />}
      </div>}
      {compared && <div hidden={tab !== "compare"}><ModelComparison onBusy={onCompareBusy} /></div>}
      {active && tab !== "compare" && <section ref={inspectorRef} tabIndex={-1} aria-label="Model inspector" className="rounded-xl border border-hair bg-surface">
        <div className="flex justify-end p-2"><button aria-label="Close model details" onClick={closeInspector} className="px-3 py-1 text-sm text-fg-muted">Close</button></div>
        <ModelDetailAside key={active.id} model={active} download={downloads[active.id]} totalMemoryBytes={profile?.memory_bytes ?? null} chip={profile?.chip ?? null}
          onDownload={() => startDownload(active.id)} onRemove={() => setPendingRemove(true)}
          onOpenInChat={context => onTry(active.id, context).catch(e=>{setActionError(String(e));})} onBenchmark={() => onBenchmark(active.id)} />
      </section>}
      <ConfirmDialog open={pendingRemove} title="Remove model?" body={"Remove " + (active?.name ?? "model") + " from disk? You can download it again."} confirmLabel="Remove" onCancel={() => setPendingRemove(false)} onConfirm={() => {
        setPendingRemove(false); if(active) void removeModel(active.id).then(()=>setSelected(null)).catch(e=>setActionError(String(e)));
      }} />
    </div>
  </div>;
}
