import { useEffect, useRef, useState } from "react";
import type { LibraryModel, ModelsTab } from "../types";
import { useModels } from "../lib/useModels";
import { useHardwareProfile } from "../lib/useHardwareProfile";
import { formatBytes } from "../lib/format";
import { hardwareHint } from "../lib/hint";
import { DEFAULT_CONTEXT } from "../lib/fit";
import { ModelDetailAside } from "./ModelDetailAside";
import { SuggestedModels } from "./SuggestedModels";
import { BrowsePage } from "./BrowsePage";
import { ModelComparison } from "./ModelComparison";
import { Tabs } from "./ui/Tabs";
import { ConfirmDialog } from "./ui/ConfirmDialog";
import { ChevronRightIcon, PlusIcon, RefreshIcon, SearchIcon } from "./icons";
import { Meta, PageHeader, PrimaryButton } from "./PageHeader";

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
      <PageHeader title={tab === "compare" ? "Compare" : "Models"}
        meta={tab !== "compare" && <>
          <Meta k="Installed">{installed.length}</Meta>
          <Meta k="On disk">{formatBytes(installed.reduce((sum,m) => sum + (m.size_bytes ?? 0),0))}</Meta>
          <Meta k="Machine">{profile?.chip ?? "Your Mac"}{profile?.memory_bytes ? " · " + formatBytes(profile.memory_bytes) : ""}</Meta>
        </>}
        actions={tab !== "compare" && <PrimaryButton onClick={() => switchTab("discover")}><PlusIcon className="size-3.5" />Add model</PrimaryButton>} />
      <Tabs ariaLabel="Models view" value={tab === "browse" ? "discover" : tab} onChange={switchTab} items={[{key:"installed",label:"Installed",count:installed.length},{key:"discover",label:"Find"},{key:"compare",label:"Compare"}]} />
      <div className={"model-workspace " + (active && tab !== "compare" ? "has-inspector" : "")}><div className="model-content flex min-w-0 flex-col gap-5">
      {tab === "installed" && <div className="flex flex-wrap items-center gap-3">
        <label className="flex h-8 min-w-[180px] flex-1 items-center gap-2 rounded-control border border-hair bg-inset px-3 transition-colors hover:border-hair2 focus-within:border-hair2 focus-within:ring-2 focus-within:ring-accent-line"><SearchIcon className="size-3.5 text-fg-muted" /><input aria-label="Search installed models" placeholder="Search installed models…" value={query} onChange={e => setQuery(e.target.value)} className="min-w-0 flex-1 bg-transparent text-[13px] outline-none placeholder:text-fg-subtle" /></label>
        <div className="button-group"><button aria-pressed={fitsOnly} onClick={() => setFitsOnly(v=>!v)}>Fits at 4K</button></div>
        <button aria-label="Refresh installed models" title="Refresh installed models" onClick={reload} className="flex size-8 items-center justify-center rounded-control border border-hair text-fg-muted transition-colors hover:border-hair2 hover:text-fg"><RefreshIcon className="size-3.5" /></button>
      </div>}
      {(error || actionError) && <div role="alert" className="flex items-center gap-3 rounded-lg border border-hair p-3 text-sm"><span className="flex-1">{actionError ?? error}</span><button onClick={() => {setActionError(null); reload();}} className="text-accent-text">Retry</button></div>}
      {tab === "installed" && (loading ? <p role="status">Loading your models…</p> : installed.length === 0 ?
        <div className="py-12"><h2 className="text-lg font-medium">Choose your first local model</h2><p className="mt-2 text-sm text-fg-muted">Find a model for your task and check its memory fit before downloading.</p><PrimaryButton onClick={() => switchTab("discover")} className="mt-4">Find a model</PrimaryButton></div> :
        <div aria-label="Installed model list" className="model-table">
          <div className="model-columns model-table-header th" aria-hidden="true"><span>model</span><span>size</span><span>quant</span><span>fit @ 4K</span><span>decode</span><span /></div>
          {rows.map(m => {const hint=hintFor(m); return <button key={m.id} aria-label={"Inspect " + m.name} aria-pressed={active?.id === m.id} onClick={() => select(m.id)} className="model-columns model-row">
            <span className="flex min-w-0 items-baseline gap-2.5"><span className="truncate text-[13px] font-medium">{m.name}</span><span className="data truncate text-[11px] text-fg-subtle">{m.id}</span></span>
            <span className="data text-[12px] text-fg-muted">{formatBytes(m.size_bytes)}</span><span className="data text-[12px] text-fg-muted">{m.spec.quant}</span>
            <span className={"flex items-center gap-1.5 text-[12px] " + hint.tone}><span className="size-1.5 shrink-0 rounded-full bg-current" aria-hidden />{hint.label}</span>
            <span className="flex items-baseline gap-1.5 whitespace-nowrap text-fg-muted" title={hint.tps ? (hint.tps.source === "measured" ? "Measured" : "Estimated") : "Speed unknown"}><span className="data text-[12px] text-fg">{hint.tps ? hint.tpsLabel : "—"}</span><span className="text-[11px] text-fg-subtle">{hint.tps ? hint.tps.source === "measured" ? "measured" : "est." : ""}</span></span>
            <ChevronRightIcon className="size-3.5 text-fg-subtle" />
          </button>})}
          {rows.length === 0 && <p className="border-t border-hair px-4 py-8 text-sm text-fg-muted">No models match these filters.</p>}
        </div>)}
      {(tab === "discover" || tab === "browse") && <div>
        <div className="button-group mb-5">{([['discover','Suggested'],['browse','Ollama library']] as const).map(([mode,label])=><button key={mode} aria-pressed={findMode === mode} onClick={() => setFindMode(mode)}>{label}</button>)}</div>
        {findMode === "discover" ? <SuggestedModels onSelect={select} /> : <BrowsePage onSelect={setSelected} selectedTag={selected?.id ?? null} />}
      </div>}
      {compared && <div hidden={tab !== "compare"}><ModelComparison onBusy={onCompareBusy} /></div>}
      </div>
      {active && tab !== "compare" && <section ref={inspectorRef} tabIndex={-1} aria-label="Model inspector" className="model-inspector">
        <ModelDetailAside key={active.id} onClose={closeInspector} model={active} download={downloads[active.id]} totalMemoryBytes={profile?.memory_bytes ?? null} chip={profile?.chip ?? null}
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
