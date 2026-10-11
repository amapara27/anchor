import { useState } from "react";
import type { BenchRun, DownloadState, LibraryModel } from "../types";
import { formatBytes, formatContext, formatParams, formatTokSec, parseSize, parseTagParams, parseTagQuant } from "../lib/format";
import { DEFAULT_CONTEXT } from "../lib/fit";
import { hardwareHint } from "../lib/hint";
import { tagFit, tagToLibraryModel } from "../lib/tagFit";
import { useLibraryTags } from "../lib/useLibrary";
import { startQuickMeasure, stopQuickMeasure, useQuickMeasure } from "../lib/useQuickMeasure";
import { SegmentedBar } from "./ui/SegmentedBar";
import { CodeBlock } from "./ui/CodeBlock";
import { GhostButton, PrimaryButton } from "./PageHeader";
import { DownloadProgressBar } from "./DownloadProgressBar";
import { ChevronRightIcon, TrashIcon, XIcon } from "./icons";

const GIB = 1024 ** 3;

/** On-demand inspector. Fit is judged at the Models header's context, which Try also uses. */
export function ModelDetailAside({model, context, measured, ollamaVersion, host, hostLocal, download, totalMemoryBytes, chip, onDownload, onRemove, onOpenInChat, onBenchmark, onSelectTag, onClose}: {
  onClose?: () => void;
  model: LibraryModel | null;
  /** The global fit context; capped here at the model's own limit. */
  context: number;
  /** This Mac's latest headline run for the model, if it has been measured. */
  measured?: BenchRun;
  ollamaVersion: string | null;
  host: string;
  hostLocal: boolean;
  download?: DownloadState;
  totalMemoryBytes: number | null;
  chip: string | null;
  onDownload: () => void;
  onRemove: () => void;
  onOpenInChat: (context: number) => Promise<void>;
  onBenchmark: () => void;
  onSelectTag: (model: LibraryModel) => void;
}) {
  const [trying, setTrying] = useState(false);
  const quick = useQuickMeasure();
  if (!model) return null;
  const maxContext = model.spec.context_tokens || DEFAULT_CONTEXT;
  const fitCtx = Math.min(context, maxContext);
  const hardware = {memory_bytes: totalMemoryBytes, chip};
  const hintModel = {id: model.id, params_b: model.spec.params_b, quant: model.spec.quant,
    contextTokens: maxContext, arch: model.arch, sizeBytes: model.size_bytes, measuredTps: measured?.decode_tps_median};
  const hint = hardwareHint(hintModel, hardware, fitCtx);
  const {weightsGB, kvCacheGB, computeBufferGB, osReserveGB, availableGB, totalNeededGB} = hint.fit.breakdown;
  const segments = availableGB > 0 ? [
    {label:"weights", fraction:weightsGB/availableGB, color:"var(--accent)"},
    {label:"KV cache", fraction:kvCacheGB/availableGB, color:"var(--accent-line)"},
    {label:"compute", fraction:computeBufferGB/availableGB, color:"var(--hair2)"},
    {label:"OS reserve", fraction:osReserveGB/availableGB, color:"var(--hair)"},
  ] : [];
  const installed = model.status === "installed";
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
       installed ? <div className="flex flex-wrap gap-2">
         <PrimaryButton disabled={trying} onClick={() => {setTrying(true); void onOpenInChat(fitCtx).finally(()=>setTrying(false));}}>{trying ? "Opening…" : "Try model"}</PrimaryButton>
         <GhostButton onClick={onBenchmark}>Benchmark</GhostButton>
         <button type="button" onClick={onRemove} aria-label="Remove model" title="Remove model" className="ml-auto flex size-8 items-center justify-center rounded-lg text-fg-muted transition-colors hover:bg-inset hover:text-danger focus:outline-none focus-visible:ring-2 focus-visible:ring-accent-line"><TrashIcon className="size-4" /></button>
       </div> : <PrimaryButton onClick={onDownload}>Download · {formatBytes(model.spec.download_bytes)}</PrimaryButton>}
    </header>
    <section aria-label="Memory fit" className="flex flex-col gap-3 border-t border-hair pt-4">
      <div className="flex flex-wrap items-baseline justify-between gap-3">
        <span className={"flex items-center gap-1.5 text-[13px] " + hint.tone}><span className="size-1.5 rounded-full bg-current" aria-hidden />{hint.label} at {formatContext(fitCtx)}</span>
        {fitCtx < context && <span className="text-[12px] text-fg-muted">model limit {formatContext(maxContext)}</span>}
      </div>
      {segments.length > 0 && <SegmentedBar segments={segments} height={6} />}
      <p className="text-[12px] text-fg-muted"><span className="data text-fg">{totalNeededGB.toFixed(1)} GiB estimated RAM</span>{availableGB > 0 ? ` · ${hint.fit.headroomGB.toFixed(1)} GiB estimated headroom` : " · Memory capacity unknown"}</p>
      {measured?.resident_bytes != null && <ObservedMemory run={measured} hintModel={hintModel} hardware={hardware} />}
    </section>
    <dl className="flex flex-col border-t border-hair pt-2 text-[13px]">
      <div className={fact}><dt className="text-fg-muted">Parameters</dt><dd className="data text-[12px]">{formatParams(model.spec.params_b)}</dd></div>
      <div className={fact}><dt className="text-fg-muted">Quantization</dt><dd className="data text-[12px]">{model.spec.quant}</dd></div>
      <div className={fact}><dt className="text-fg-muted">{installed ? "On disk" : "Download"}</dt><dd className="data text-[12px]">{formatBytes(model.size_bytes)}</dd></div>
      <div className={fact}><dt className="text-fg-muted">Decode speed</dt><dd className="flex items-baseline gap-2 text-[12px]">
        <span className="data">{hint.tps ? `${hint.tpsLabel} ${hint.tps.source === "measured" ? "measured" : "est."}` : "unknown"}</span>
        {installed && (quick.running === model.id
          ? <><span className="text-fg-muted">Measuring…</span><button onClick={stopQuickMeasure} className="text-accent-text">Stop</button></>
          : <button disabled={quick.running != null} title={quick.running ? "Another measurement is running" : "Run the headline scenario once on this Mac"} onClick={() => startQuickMeasure(model.id)} className="text-accent-text disabled:text-fg-subtle">{measured ? "Re-measure" : "Measure"}</button>)}
      </dd></div>
      {measured && <VersionNote run={measured} current={ollamaVersion} />}
      {quick.failed?.model === model.id && <p role="alert" className="py-1 text-[12px] text-danger">Measurement failed: {quick.failed.message}</p>}
      <div className={fact}><dt className="text-fg-muted">Publisher</dt><dd className="text-[12px]">{model.spec.publisher}</dd></div>
    </dl>
    <QuantTable model={model} context={fitCtx} hardware={hardware} onSelect={onSelectTag} />
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
    {installed && <details className="group border-t border-hair pt-3">
      <summary className="flex cursor-pointer list-none items-center gap-1.5 text-[13px] text-fg-muted transition-colors hover:text-fg [&::-webkit-details-marker]:hidden"><ChevronRightIcon className="size-3.5 transition-transform group-open:rotate-90" />Use from other apps</summary>
      <div className="mt-3 flex flex-col gap-3">
        {!hostLocal && <p className="text-xs text-fg-muted">The configured server isn't on this Mac; these commands point at it.</p>}
        <CodeBlock language="shell" code={`ollama run ${model.id}`} />
        <CodeBlock language="OpenAI base URL" code={`${host}/v1`} />
        <CodeBlock language="shell" code={`curl ${host}/v1/chat/completions \\\n  -H "Content-Type: application/json" \\\n  -d '{"model": "${model.id}", "messages": [{"role": "user", "content": "Hello"}]}'`} />
      </div>
    </details>}
  </div>;
}

/** What Ollama actually allocated during the last measurement, beside what the estimate says for that context. */
function ObservedMemory({run, hintModel, hardware}: {
  run: BenchRun; hintModel: Parameters<typeof hardwareHint>[0]; hardware: Parameters<typeof hardwareHint>[1];
}) {
  // `/api/ps size` is the model's own allocation, so compare it without the OS reserve.
  const b = hardwareHint(hintModel, hardware, run.num_ctx).fit.breakdown;
  const predicted = b.weightsGB + b.kvCacheGB + b.computeBufferGB;
  const observed = (run.resident_bytes ?? 0) / GIB;
  const delta = predicted > 0 ? Math.round((observed / predicted - 1) * 100) : null;
  return <p className="text-[12px] text-fg-muted">At {formatContext(run.num_ctx)}: <span className="data text-fg">{predicted.toFixed(1)} GiB predicted</span> · <span className="data text-fg">{observed.toFixed(1)} GiB observed</span>{delta != null && <span className="data"> ({delta > 0 ? "+" : ""}{delta}%)</span>}</p>;
}

/** Flags a measurement taken on another Ollama version, and the speed change across the last upgrade. */
function VersionNote({run, current}: {run: BenchRun; current: string | null}) {
  const stale = run.ollama_version && current && run.ollama_version !== current;
  const prev = run.prev_decode_tps_median, now = run.decode_tps_median;
  const change = prev && now ? Math.round((now / prev - 1) * 100) : null;
  if (!stale && change == null) return null;
  return <p className="py-1 text-right text-[12px] text-fg-muted">
    {stale && <span className="text-warn">Measured on Ollama {run.ollama_version} (now {current})</span>}
    {stale && change != null && " · "}
    {change != null && <span className="data">{change > 0 ? "+" : ""}{change}% vs Ollama {run.prev_ollama_version} ({formatTokSec(prev!)})</span>}
  </p>;
}

/** The quants most people choose between; the rest sit behind "Show all". */
const COMMON_QUANTS = new Set(["Q4_K_M", "Q5_K_M", "Q6_K", "Q8_0", "F16"]);

/** A tag's variant word with size and quant removed: `1b-text-q4_K_M` → "text"; instruct is the default. */
function variantOf(tag: string): string {
  return (tag.split(":")[1] ?? "").split("-")
    .filter(part => !/^[\d.x]+[bm]$/i.test(part) && !parseTagQuant("x:" + part) && part !== "instruct" && part !== "latest")
    .join("-");
}

/** Published quants of this model's size and variant, with fit at the current context. */
function QuantTable({model, context, hardware, onSelect}: {
  model: LibraryModel; context: number; hardware: {memory_bytes: number | null; chip: string | null};
  onSelect: (model: LibraryModel) => void;
}) {
  const [showAll, setShowAll] = useState(false);
  // Only plain library ids (`name:tag`) have a library tag list to look up.
  const library = /^[\w.-]+:[\w.-]+$/.test(model.id) ? model.id.split(":")[0] : null;
  const {tags, error} = useLibraryTags(library);
  if (!library) return null;
  const params = parseTagParams(model.id) ?? model.spec.params_b;
  const variant = variantOf(model.id);
  // One row per build: aliases like `1b` and `1b-instruct-q8_0` share a digest.
  const groups = new Map<string, {tag: NonNullable<typeof tags>[number]; names: string[]}>();
  for (const t of tags ?? []) {
    const p = parseTagParams(t.tag);
    if (!p || !params || Math.abs(p - params) > params * 0.15) continue;
    const group = groups.get(t.digest);
    if (group) group.names.push(t.tag);
    else groups.set(t.digest, {tag: t, names: [t.tag]});
  }
  const list = [...groups.values()]
    .map(g => {
      const named = g.names.find(n => parseTagQuant(n));
      return {...g, quant: named ? parseTagQuant(named)! : "default", variant: variantOf(named ?? g.names[0]),
        current: g.names.includes(model.id), fit: tagFit(g.tag, model.arch, hardware, context)};
    })
    .filter(r => r.variant === variant || r.current)
    .sort((a, b) => (parseSize(a.tag.size) ?? 0) - (parseSize(b.tag.size) ?? 0));
  const shown = showAll ? list : list.filter(r => r.current || COMMON_QUANTS.has(r.quant));
  const cols = "grid grid-cols-[minmax(0,1fr)_56px_64px_72px] gap-2";
  return <section aria-label="Quantizations" className="flex flex-col gap-2 border-t border-hair pt-4">
    <h3 className="text-[13px] font-medium">Quantizations <span className="font-normal text-fg-muted">at {formatContext(context)} · GiB</span></h3>
    {error ? <p className="text-[12px] text-fg-muted">Couldn't load variants from the Ollama library.</p> :
     !tags ? <p role="status" className="text-[12px] text-fg-muted">Loading variants…</p> :
     list.length === 0 ? <p className="text-[12px] text-fg-muted">No other published variants of this size.</p> :
     <div className="flex flex-col">
       <div className={"th pb-1.5 " + cols} aria-hidden="true"><span>quant</span><span className="text-right">size</span><span className="text-right">est. RAM</span><span className="text-right">headroom</span></div>
       {shown.map(({tag, names, quant, current, fit}) => {
         const bytes = parseSize(tag.size);
         return <button key={tag.digest} aria-label={"Inspect " + tag.tag} aria-current={current || undefined} title={names.join(", ")}
           onClick={() => !current && onSelect(tagToLibraryModel({name: library, description: model.spec.blurb}, tag, model.arch, false))}
           className={cols + " -mx-1.5 items-baseline rounded-[4px] px-1.5 py-1 text-left text-[12px] transition-colors " + (current ? "bg-accent-soft" : "hover:bg-inset")}>
           <span className="data truncate">{quant}</span>
           <span className="data text-right text-fg-muted">{bytes ? (bytes / GIB).toFixed(1) : "—"}</span>
           <span className="data text-right text-fg-muted">{fit ? fit.fit.breakdown.totalNeededGB.toFixed(1) : "—"}</span>
           <span className={"data flex items-center justify-end gap-1.5 " + (fit?.tone ?? "text-fg-subtle")}>{fit && <span className="size-1.5 rounded-full bg-current" aria-hidden />}{fit && fit.tier !== "unknown" ? `${fit.fit.headroomGB >= 0 ? "+" : "−"}${Math.abs(fit.fit.headroomGB).toFixed(1)}` : "—"}</span>
         </button>;
       })}
       {list.length > shown.length || showAll ? <button onClick={() => setShowAll(v => !v)} className="mt-1 self-start text-[12px] text-accent-text">
         {showAll ? "Show fewer" : `Show all ${list.length}`}</button> : null}
     </div>}
  </section>;
}
