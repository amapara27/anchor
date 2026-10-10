import { useMemo, useState } from "react";
import type { FitTier, LibraryModel } from "../types";
import { useModels } from "../lib/useModels";
import { useHardwareProfile } from "../lib/useHardwareProfile";
import { formatBytes, formatContext, formatParams } from "../lib/format";
import { hardwareHint } from "../lib/hint";
import { DEFAULT_CONTEXT, fitContext } from "../lib/fit";
import { DownloadProgressBar } from "./DownloadProgressBar";
import { CheckIcon, DownloadIcon, SearchIcon } from "./icons";
import { Button } from "./ui/Button";

const TIER_ORDER: Record<FitTier, number> = { ok: 0, tight: 1, wont_fit: 2, unknown: 3 };

/** The curated catalog as a plain, filterable list — best fit on this Mac first. */
export function SuggestedModels({ onSelect }: { onSelect: (id: string) => void }) {
  const { models, downloads, startDownload, cancelDownload } = useModels();
  const { profile } = useHardwareProfile();
  const [query, setQuery] = useState("");
  const [fitsOnly, setFitsOnly] = useState(false);

  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    return models
      .filter(m => m.curated)
      .map(m => ({ model: m, hint: hardwareHint({ id: m.id, params_b: m.spec.params_b, quant: m.spec.quant,
        contextTokens: m.spec.context_tokens || DEFAULT_CONTEXT, arch: m.arch, sizeBytes: m.size_bytes }, profile) }))
      .filter(({ model: m, hint }) => (!fitsOnly || hint.tier === "ok") && (!q ||
        [m.name, m.id, m.spec.publisher, m.spec.blurb, ...m.spec.use_cases].join(" ").toLowerCase().includes(q)))
      // Stable sort keeps the authored catalog order within a tier.
      .sort((a, b) => TIER_ORDER[a.hint.tier] - TIER_ORDER[b.hint.tier]);
  }, [models, profile, query, fitsOnly]);

  return <div className="flex flex-col gap-4">
    <div className="flex flex-wrap items-center gap-3">
      <label className="flex h-8 min-w-[180px] flex-1 items-center gap-2 rounded-control border border-hair bg-inset px-3 transition-colors hover:border-hair2 focus-within:border-hair2 focus-within:ring-2 focus-within:ring-accent-line">
        <SearchIcon className="size-3.5 text-fg-muted" />
        <input aria-label="Filter suggested models" placeholder="Filter by name, publisher or use case…" value={query} onChange={e => setQuery(e.target.value)}
          className="min-w-0 flex-1 bg-transparent text-[13px] outline-none placeholder:text-fg-subtle" />
      </label>
      <div className="button-group"><button aria-pressed={fitsOnly} onClick={() => setFitsOnly(v => !v)}>Fits at 4K</button></div>
    </div>
    {rows.length === 0 ? <p className="rounded-card border border-dashed border-hair2 px-4 py-10 text-center text-sm text-fg-muted">No suggested models match.</p> :
      <div className="row-list">{rows.map(({ model, hint }) => <SuggestedRow key={model.id} model={model} hint={hint}
        download={downloads[model.id]} onSelect={() => onSelect(model.id)}
        onDownload={() => startDownload(model.id)} onCancel={() => cancelDownload(model.id)} />)}</div>}
  </div>;
}

function SuggestedRow({ model, hint, download, onSelect, onDownload, onCancel }: {
  model: LibraryModel; hint: ReturnType<typeof hardwareHint>;
  download?: ReturnType<typeof useModels>["downloads"][string];
  onSelect: () => void; onDownload: () => void; onCancel: () => void;
}) {
  const { spec } = model;
  return <div role="button" tabIndex={0} aria-label={"Inspect " + model.name}
    onClick={onSelect} onKeyDown={e => {
      if (e.target === e.currentTarget && (e.key === "Enter" || e.key === " ")) { e.preventDefault(); onSelect(); }
    }} className="row-item cursor-pointer">
    <div className="flex flex-wrap items-baseline gap-x-3 gap-y-1">
      <h3 className="text-[14px] font-semibold tracking-tight">{model.name}</h3>
      <span className="data text-[12px] text-fg-subtle">{model.id}</span>
    </div>
    <p className="mt-1.5 max-w-[75ch] text-[13px] leading-relaxed text-fg-muted">{spec.blurb}</p>
    <div className="mt-3 flex flex-wrap items-center gap-3">
      <span className="data flex min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-1 text-[12px] text-fg-muted">
        <span>{spec.publisher}</span><Dot /><span>{formatParams(spec.params_b)}</span><Dot /><span>{spec.quant}</span><Dot /><span>{formatContext(spec.context_tokens)} ctx</span><Dot />
        <span className={"flex items-center gap-1.5 font-sans " + hint.tone}><span className="size-1.5 rounded-full bg-current" aria-hidden />{hint.label} at {formatContext(fitContext(spec.context_tokens || DEFAULT_CONTEXT))}</span><Dot />
        <span>{hint.fit.breakdown.totalNeededGB.toFixed(1)} GiB est. RAM</span>
        {spec.capabilities.length > 0 && <><Dot /><span className="font-sans">{spec.capabilities.join(", ")}</span></>}
      </span>
      {model.status === "installed" ? <span className="flex items-center gap-1.5 text-xs text-fg-muted"><CheckIcon className="size-3 text-ok" />Installed</span> :
        download ? <Button onClick={e => { e.stopPropagation(); onCancel(); }} className="text-xs">Cancel download</Button> :
        <Button aria-label={"Download " + model.name} onClick={e => { e.stopPropagation(); onDownload(); }} className="text-xs"><DownloadIcon className="size-3.5" />Download · {formatBytes(spec.download_bytes)}</Button>}
    </div>
    {download && <DownloadProgressBar download={download} totalBytes={spec.download_bytes} />}
  </div>;
}

const Dot = () => <span className="text-fg-subtle" aria-hidden>·</span>;
