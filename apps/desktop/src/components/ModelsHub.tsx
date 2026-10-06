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
import { ChevronRightIcon, PlusIcon, RefreshIcon, SearchIcon, XIcon } from "./icons";

export function ModelsHub({openModel, initialTab = "installed", onTabChange, onTry, onBenchmark, onCompareBusy}: {
  openModel: {id: string; nonce: number} | null; initialTab?: ModelsTab;
  onCompareBusy?: (busy: boolean) => void;
  onTabChange: (tab: ModelsTab) => void;
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
  const switchTab = (next: ModelsTab) => { setTab(next); onTabChange(next); setSelected(null); if (next === "compare") setCompared(true); };
  return <div className="scrollbar-slim min-w-0 flex-1 overflow-y-auto">
    <div className="tool-page">
      <header className="page-header">
        <div><h1 className="page-title">{tab === "compare" ? "Compare" : "Models"}</h1></div>
        {tab !== "compare" && <button onClick={() => switchTab("discover")} className="ml-auto flex items-center gap-2 rounded-control bg-accent px-3 py-2 text-xs font-medium text-accent-fg"><PlusIcon className="size-3.5" />Add model</button>}
      </header>
      {tab !== "compare" && <div className="flex flex-wrap items-center gap-x-5 gap-y-2 text-xs text-fg-muted" aria-label="Model library summary">
        <span><span className="data text-fg">{installed.length}</span> installed</span>
        <span><span className="data text-fg">{formatBytes(installed.reduce((sum,m) => sum + (m.size_bytes ?? 0),0))}</span> on disk</span>
        <span className="ml-auto">{profile?.chip ?? "Your Mac"}{profile?.memory_bytes ? " · " + formatBytes(profile.memory_bytes) + " RAM" : ""}</span>
      </div>}
      <Tabs ariaLabel="Models view" value={tab === "browse" ? "discover" : tab} onChange={switchTab} items={[{key:"installed",label:"Installed",count:installed.length},{key:"discover",label:"Find"},{key:"compare",label:"Compare"}]} />
      <div className={"model-workspace " + (active && tab !== "compare" ? "has-inspector" : "")}><div className="model-content flex min-w-0 flex-col gap-5">
      {tab === "installed" && <div className="flex flex-wrap items-center gap-3">
        <label className="flex min-w-[180px] flex-1 items-center gap-2 rounded-control border border-hair px-3 py-2 focus-within:ring-2 focus-within:ring-accent-line"><SearchIcon className="size-3.5 text-fg-muted" /><input aria-label="Search installed models" placeholder="Search installed models…" value={query} onChange={e => setQuery(e.target.value)} className="min-w-0 flex-1 bg-transparent text-xs outline-none" /></label>
        <button aria-pressed={fitsOnly} onClick={() => setFitsOnly(v=>!v)} className={"rounded-control border border-hair px-3 py-2 text-xs " + (fitsOnly ? "bg-raised text-fg" : "text-fg-muted")}>Fits at 4K</button>
        <button aria-label="Refresh installed models" title="Refresh installed models" onClick={reload} className="rounded-control border border-hair p-2 text-fg-muted hover:text-fg"><RefreshIcon className="size-3.5" /></button>
      </div>}
      {(error || actionError) && <div role="alert" className="flex items-center gap-3 rounded-lg border border-hair p-3 text-sm"><span className="flex-1">{actionError ?? error}</span><button onClick={() => {setActionError(null); reload();}} className="text-accent-text">Retry</button></div>}
      {tab === "installed" && (loading ? <p role="status">Loading your models…</p> : installed.length === 0 ?
        <div className="py-12"><h2 className="text-lg font-medium">Choose your first local model</h2><p className="mt-2 text-sm text-fg-muted">Find a model for your task and check its memory fit before downloading.</p><button onClick={() => switchTab("discover")} className="mt-4 rounded-lg bg-accent px-4 py-2 text-sm text-accent-fg">Find a model</button></div> :
        <div aria-label="Installed model list" className="model-table">
          <div className="model-columns model-table-header" aria-hidden="true"><span>Model</span><span>Size</span><span>Quant</span><span>Fit · 4K</span><span>Decode speed</span><span /></div>
          {rows.map(m => {const hint=hintFor(m); return <button key={m.id} aria-label={"Inspect " + m.name} aria-pressed={active?.id === m.id} onClick={() => select(m.id)} className="model-columns model-row">
            <span className="min-w-0"><span className="block truncate text-[13px] font-medium">{m.name}</span><span className="data mt-1 block truncate text-[10px] text-fg-subtle">{m.id}</span></span>
            <span className="data text-[11px] text-fg-muted">{formatBytes(m.size_bytes)}</span><span className="data text-[11px] text-fg-muted">{m.spec.quant}</span><span className={"text-[11px] " + hint.tone}>{hint.label}</span>
            <span className="flex flex-col gap-0.5 text-fg-muted"><span className="data text-[11px]">{hint.tps ? hint.tpsLabel : "—"}</span><span className="text-[10px] text-fg-subtle">{hint.tps ? hint.tps.source === "measured" ? "Measured" : "Estimated" : "Speed unknown"}</span></span>
            <ChevronRightIcon className="size-3.5 text-fg-subtle" />
          </button>})}
          {rows.length === 0 && <p className="py-8 text-sm text-fg-muted">No models match these filters.</p>}
        </div>)}
      {(tab === "discover" || tab === "browse") && <div>
        <div className="mb-6 flex gap-2">{([['discover','By task'],['browse','Ollama library']] as const).map(([mode,label])=><button key={mode} aria-pressed={findMode === mode} onClick={() => setFindMode(mode)} className={"rounded-control border border-hair px-3 py-1.5 text-xs " + (findMode === mode ? "bg-raised text-fg" : "text-fg-muted")}>{label}</button>)}</div>
        {findMode === "discover" ? <SearchPage onSelect={select} /> : <BrowsePage onSelect={setSelected} selectedTag={selected?.id ?? null} />}
      </div>}
      {compared && <div hidden={tab !== "compare"}><ModelComparison onBusy={onCompareBusy} /></div>}
      </div>
      {active && tab !== "compare" && <section ref={inspectorRef} tabIndex={-1} aria-label="Model inspector" className="model-inspector">
        <div className="flex items-center justify-between px-5 py-2"><span className="text-xs text-fg-muted">Model details</span><button aria-label="Close model details" onClick={closeInspector} className="rounded p-1 text-fg-muted hover:text-fg"><XIcon className="size-4" /></button></div>
        <ModelDetailAside key={active.id} model={active} download={downloads[active.id]} totalMemoryBytes={profile?.memory_bytes ?? null} chip={profile?.chip ?? null}
          onDownload={() => startDownload(active.id)} onRemove={() => setPendingRemove(true)}
          onOpenInChat={context => onTry(active.id, context).catch(e=>{setActionError(String(e));})} onBenchmark={() => onBenchmark(active.id)} />
      </section>}
      </div>
      <ConfirmDialog open={pendingRemove} title="Remove model?" body={"Remove " + (active?.name ?? "model") + " from disk? You can download it again."} confirmLabel="Remove" onCancel={() => setPendingRemove(false)} onConfirm={() => {
        setPendingRemove(false); if(active) void removeModel(active.id).then(()=>setSelected(null)).catch(e=>setActionError(String(e)));
      }} />
    </div>
  </div>;
}
