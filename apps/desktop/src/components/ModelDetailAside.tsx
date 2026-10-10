import { useState } from "react";
import type { DownloadState, LibraryModel } from "../types";
import { formatBytes, formatContext, formatParams } from "../lib/format";
import { DEFAULT_CONTEXT } from "../lib/fit";
import { hardwareHint } from "../lib/hint";
import { SegmentedBar } from "./ui/SegmentedBar";
import { GhostButton, PrimaryButton } from "./PageHeader";
import { DownloadProgressBar } from "./DownloadProgressBar";
import { ChevronRightIcon, TrashIcon, XIcon } from "./icons";

/** On-demand inspector. The selected configuration is used by both fit and Try. */
export function ModelDetailAside({model, download, totalMemoryBytes, chip, onDownload, onRemove, onOpenInChat, onBenchmark, onClose}: {
  onClose?: () => void;
  model: LibraryModel | null;
  download?: DownloadState;
  totalMemoryBytes: number | null;
  chip: string | null;
  onDownload: () => void;
  onRemove: () => void;
  onOpenInChat: (context: number) => Promise<void>;
  onBenchmark: () => void;
}) {
  const maxContext = model?.spec.context_tokens || DEFAULT_CONTEXT;
  const [context, setContext] = useState(() => Math.min(DEFAULT_CONTEXT, maxContext));
  const [trying, setTrying] = useState(false);
  if (!model) return null;
  const fitCtx = Math.min(context, maxContext);
  const hint = hardwareHint({id: model.id, params_b: model.spec.params_b, quant: model.spec.quant,
    contextTokens: maxContext, arch: model.arch, sizeBytes: model.size_bytes}, {memory_bytes: totalMemoryBytes, chip}, fitCtx);
  const {weightsGB, kvCacheGB, computeBufferGB, osReserveGB, availableGB, totalNeededGB} = hint.fit.breakdown;
  const contexts = [...new Set([Math.min(DEFAULT_CONTEXT, maxContext), 8192,16384,32768,65536,131072,262144])].filter(n=>n <= maxContext);
  const segments = availableGB > 0 ? [
    {label:"weights", fraction:weightsGB/availableGB, color:"var(--accent)"},
    {label:"KV cache", fraction:kvCacheGB/availableGB, color:"var(--accent-line)"},
    {label:"compute", fraction:computeBufferGB/availableGB, color:"var(--hair2)"},
    {label:"OS reserve", fraction:osReserveGB/availableGB, color:"var(--hair)"},
  ] : [];
  const fact = "flex items-baseline justify-between gap-3 py-1.5";
  return <div className="flex flex-col gap-5 px-5 pb-5">
    <header className="flex flex-col gap-3">
      <div className="flex items-start gap-3">
        <div className="min-w-0 flex-1"><h2 className="text-lg font-semibold tracking-tight">{model.name}</h2>
          <p className="data mt-0.5 truncate text-[12px] text-fg-muted">{model.id}</p>
        </div>
        {onClose && <button aria-label="Close model details" onClick={onClose} className="-mr-1 rounded p-1 text-fg-muted transition-colors hover:bg-inset hover:text-fg"><XIcon className="size-4" /></button>}
      </div>
      {download && download.status !== "done" ? <DownloadProgressBar download={download} totalBytes={model.spec.download_bytes} /> :
       model.status === "installed" ? <div className="flex flex-wrap gap-2">
         <PrimaryButton disabled={trying} onClick={() => {setTrying(true); void onOpenInChat(fitCtx).finally(()=>setTrying(false));}}>{trying ? "Opening trial…" : "Try model"}</PrimaryButton>
         <GhostButton onClick={onBenchmark}>Benchmark</GhostButton>
         <button type="button" onClick={onRemove} aria-label="Remove model" title="Remove model" className="ml-auto flex size-8 items-center justify-center rounded-lg text-fg-muted transition-colors hover:bg-inset hover:text-danger focus:outline-none focus-visible:ring-2 focus-visible:ring-accent-line"><TrashIcon className="size-4" /></button>
       </div> : <PrimaryButton onClick={onDownload}>Download · {formatBytes(model.spec.download_bytes)}</PrimaryButton>}
    </header>
    <section aria-label="Memory fit" className="flex flex-col gap-3 border-t border-hair pt-4">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <label className="flex items-center gap-2 text-[13px] text-fg-muted">Context
          <select aria-label="Fit context" value={fitCtx} onChange={e=>setContext(Number(e.target.value))} className="select-native data">
            {contexts.map(n=><option key={n} value={n}>{formatContext(n)}</option>)}
          </select>
        </label>
        <span className={"flex items-center gap-1.5 text-[13px] " + hint.tone}><span className="size-1.5 rounded-full bg-current" aria-hidden />{hint.label} at {formatContext(fitCtx)}</span>
      </div>
      {segments.length > 0 && <SegmentedBar segments={segments} height={6} />}
      <p className="text-[12px] text-fg-muted"><span className="data text-fg">{totalNeededGB.toFixed(1)} GiB estimated RAM</span>{availableGB > 0 ? ` · ${hint.fit.headroomGB.toFixed(1)} GiB estimated headroom` : " · Memory capacity unknown"}</p>
    </section>
    <dl className="flex flex-col border-t border-hair pt-2 text-[13px]">
      <div className={fact}><dt className="text-fg-muted">Parameters</dt><dd className="data text-[12px]">{formatParams(model.spec.params_b)}</dd></div>
      <div className={fact}><dt className="text-fg-muted">Quantization</dt><dd className="data text-[12px]">{model.spec.quant}</dd></div>
      <div className={fact}><dt className="text-fg-muted">{model.status === "installed" ? "On disk" : "Download"}</dt><dd className="data text-[12px]">{formatBytes(model.size_bytes)}</dd></div>
      <div className={fact}><dt className="text-fg-muted">Decode speed</dt><dd className="data text-[12px]">{hint.tps ? `${hint.tpsLabel} ${hint.tps.source === "measured" ? "measured" : "est."}` : "unknown"}</dd></div>
      <div className={fact}><dt className="text-fg-muted">Publisher</dt><dd className="text-[12px]">{model.spec.publisher}</dd></div>
    </dl>
    <details className="group border-t border-hair pt-3">
      <summary className="flex cursor-pointer list-none items-center gap-1.5 text-[13px] text-fg-muted transition-colors hover:text-fg [&::-webkit-details-marker]:hidden"><ChevronRightIcon className="size-3.5 transition-transform group-open:rotate-90" />Memory breakdown & model details</summary>
      <div className="mt-3 flex flex-col gap-3">
        <dl className="grid grid-cols-[1fr_auto] gap-x-6 gap-y-1.5 text-[13px] text-fg-muted">
          <dt>Weights</dt><dd className="data text-right text-[12px] text-fg">{weightsGB.toFixed(1)} GiB</dd>
          <dt>KV cache at {formatContext(fitCtx)}</dt><dd className="data text-right text-[12px] text-fg">{kvCacheGB.toFixed(1)} GiB</dd>
          <dt>Compute buffer</dt><dd className="data text-right text-[12px] text-fg">{computeBufferGB.toFixed(2)} GiB</dd>
          <dt>OS reserve</dt><dd className="data text-right text-[12px] text-fg">{osReserveGB.toFixed(1)} GiB</dd>
          <dt>Model context limit</dt><dd className="data text-right text-[12px] text-fg">{formatContext(maxContext)}</dd>
        </dl>
        <p className="text-[13px] leading-relaxed text-fg-muted">{model.spec.blurb}</p>
        <p className="text-xs leading-relaxed text-fg-muted">Baseline estimate: f16 KV cache, one sequence, Flash Attention. Server settings, other apps and loaded models can change memory use.{hint.fit.kvSource === "estimated" && " KV cache size is estimated from parameter count."}</p>
      </div>
    </details>
  </div>;
}
