import { useState } from "react";
import type { DownloadState, LibraryModel } from "../types";
import { formatBytes, formatContext, formatParams } from "../lib/format";
import { DEFAULT_CONTEXT } from "../lib/fit";
import { hardwareHint } from "../lib/hint";
import { SegmentedBar } from "./ui/SegmentedBar";
import { GhostButton, PrimaryButton } from "./PageHeader";
import { DownloadProgressBar } from "./DownloadProgressBar";

/** On-demand inspector. The selected configuration is used by both fit and Try. */
export function ModelDetailAside({model, download, totalMemoryBytes, chip, onDownload, onRemove, onOpenInChat, onBenchmark}: {
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
  return <div className="flex flex-col gap-4 px-5 pb-5">
    <header className="flex flex-wrap items-start justify-between gap-3">
      <div className="min-w-0"><h2 className="text-lg font-semibold">{model.name}</h2>
        <p className="mt-1 text-sm text-fg-muted">{formatParams(model.spec.params_b)} · {model.spec.quant} · {model.spec.publisher}</p>
      </div>
      {download && download.status !== "done" ? <DownloadProgressBar download={download} totalBytes={model.spec.download_bytes} /> :
       model.status === "installed" ? <div className="flex flex-wrap gap-2">
         <PrimaryButton disabled={trying} onClick={() => {setTrying(true); void onOpenInChat(fitCtx).finally(()=>setTrying(false));}}>{trying ? "Opening trial…" : "Try model"}</PrimaryButton>
         <GhostButton onClick={onBenchmark}>Benchmark</GhostButton>
         <GhostButton onClick={onRemove} tone="danger" title="Remove model">Remove model</GhostButton>
       </div> : <PrimaryButton onClick={onDownload}>Download · {formatBytes(model.spec.download_bytes)}</PrimaryButton>}
    </header>
    <div className="flex flex-wrap items-center justify-between gap-3 border-t border-hair pt-4">
      <label className="flex items-center gap-2 text-sm text-fg-muted">Context
        <select aria-label="Fit context" value={fitCtx} onChange={e=>setContext(Number(e.target.value))} className="rounded-lg border border-hair bg-inset px-2 py-1.5 text-fg">
          {contexts.map(n=><option key={n} value={n}>{formatContext(n)}</option>)}
        </select>
      </label>
      <span className={"text-sm " + hint.tone}>{hint.label} at {formatContext(fitCtx)} · {totalNeededGB.toFixed(1)} GiB estimated RAM</span>
    </div>
    <div className="flex flex-wrap gap-x-6 gap-y-2 text-sm text-fg-muted">
      <span>{formatBytes(model.size_bytes)} {model.status === "installed" ? "on disk" : "download"}</span>
      <span>{hint.tps ? `${hint.tps.source === "measured" ? "Measured" : "Estimated"} ${hint.tpsLabel}` : "Speed unknown"}</span>
      <span>{availableGB > 0 ? `${hint.fit.headroomGB.toFixed(1)} GiB estimated headroom` : "Memory capacity unknown"}</span>
    </div>
    <details className="border-t border-hair pt-3">
      <summary className="cursor-pointer text-sm text-fg-muted">Memory breakdown & model details</summary>
      <div className="mt-3 flex flex-col gap-3">
        {segments.length > 0 && <SegmentedBar segments={segments} />}
        <dl className="grid grid-cols-2 gap-x-6 gap-y-2 text-sm text-fg-muted">
          <dt>Weights</dt><dd>{weightsGB.toFixed(1)} GiB</dd>
          <dt>KV cache at {formatContext(fitCtx)}</dt><dd>{kvCacheGB.toFixed(1)} GiB</dd>
          <dt>Compute buffer</dt><dd>{computeBufferGB.toFixed(2)} GiB</dd>
          <dt>OS reserve</dt><dd>{osReserveGB.toFixed(1)} GiB</dd>
          <dt>Model context limit</dt><dd>{formatContext(maxContext)}</dd>
        </dl>
        <p className="text-sm text-fg-muted">{model.spec.blurb}</p>
        <p className="text-xs text-fg-muted">Baseline estimate: f16 KV cache, one sequence, Flash Attention. Server settings, other apps and loaded models can change memory use.{hint.fit.kvSource === "estimated" && " KV cache size is estimated from parameter count."}</p>
      </div>
    </details>
  </div>;
}
