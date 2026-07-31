import type { DownloadState, LibraryModel } from "../types";
import { formatBytes, formatContext, formatParams, formatTokSec } from "../lib/format";
import { DEFAULT_CONTEXT, fitContext } from "../lib/fit";
import { hardwareHint } from "../lib/hint";
import { SegmentedBar } from "./ui/SegmentedBar";
import { GhostButton, PrimaryButton } from "./PageHeader";
import { DownloadProgressBar } from "./DownloadProgressBar";
import { DownloadIcon, TrashIcon } from "./icons";

/**
 * Persistent right-hand detail pane for the selected model: identity, specs,
 * the memory-fit breakdown, and the actions. Replaces the old overlay drawer —
 * the design keeps this visible alongside the table so comparing rows to the
 * detail doesn't cost a modal open/close each time.
 */
export function ModelDetailAside({
  model,
  download,
  totalMemoryBytes,
  chip,
  onDownload,
  onRemove,
  onOpenInChat,
  onBenchmark,
}: {
  model: LibraryModel | null;
  download?: DownloadState;
  totalMemoryBytes: number | null;
  chip: string | null;
  onDownload: () => void;
  onRemove: () => void;
  onOpenInChat: () => void;
  onBenchmark: () => void;
}) {
  if (!model) {
    return (
      <aside className="scrollbar-slim w-[352px] shrink-0 overflow-y-auto border-l border-hair bg-chrome">
        <p className="px-5 py-6 text-sm text-fg-subtle">Select a model to see its details.</p>
      </aside>
    );
  }

  // The context the fit is judged at — the breakdown rows must name the same one.
  const fitCtx = fitContext(model.spec.context_tokens || DEFAULT_CONTEXT);
  const hint = hardwareHint(
    {
      id: model.id,
      params_b: model.spec.params_b,
      quant: model.spec.quant,
      contextTokens: fitCtx,
      arch: model.arch,
      sizeBytes: model.size_bytes,
    },
    { memory_bytes: totalMemoryBytes, chip },
  );
  const { fit, tps } = hint;
  const installed = model.status === "installed";

  const { weightsGB, kvCacheGB, computeBufferGB, osReserveGB, availableGB } = fit.breakdown;
  const segments =
    availableGB > 0
      ? [
          { label: "weights", fraction: weightsGB / availableGB, color: "var(--accent)" },
          { label: "kv cache", fraction: kvCacheGB / availableGB, color: "var(--accent-line)" },
          { label: "compute", fraction: computeBufferGB / availableGB, color: "var(--hair2)" },
          { label: "os reserve", fraction: osReserveGB / availableGB, color: "var(--hair)" },
        ]
      : [];

  return (
    <aside className="scrollbar-slim w-[352px] shrink-0 overflow-y-auto border-l border-hair bg-chrome">
      <div className="flex flex-col gap-4 px-4.5 pb-7 pt-5">
        <div className="flex flex-col gap-2">
          <span className="label-caps">
            {model.spec.publisher} · {model.family}
          </span>
          <h2 className="data text-[17px] font-semibold tracking-tight text-fg">{model.name}</h2>
          <p className="text-[13px] leading-[1.55] text-fg-muted">{model.spec.blurb}</p>
          <div className="flex flex-wrap gap-1.5 pt-1">
            {[...model.spec.use_cases, ...model.tags].map((t) => (
              <span
                key={t}
                className="data rounded-full border border-hair px-2 py-0.5 text-[10.5px] text-fg-muted"
              >
                {t}
              </span>
            ))}
          </div>
        </div>

        <div className="grid grid-cols-2 gap-2">
          <Spec label="Parameters" value={formatParams(model.spec.params_b)} />
          <Spec label="Quantization" value={model.spec.quant} />
          <Spec label="Context" value={formatContext(model.spec.context_tokens)} />
          <Spec
            label={tps?.source === "measured" ? "Measured" : "Estimated"}
            value={tps ? formatTokSec(tps.value) : "—"}
          />
        </div>

        {segments.length > 0 && (
          <div className="card flex flex-col gap-2.5 p-3.5">
            <div className="flex items-baseline gap-2">
              <span className="label-caps">Memory fit</span>
              <span className={`data ml-auto text-[11px] ${hint.tone}`}>{hint.label.toLowerCase()}</span>
            </div>
            <SegmentedBar segments={segments} />
            <div className="data flex flex-col gap-1.5 text-[11px] text-fg-muted">
              <Row label="weights" value={`${weightsGB.toFixed(1)} GB`} />
              <Row label={`kv cache @ ${formatContext(fitCtx)}`} value={`${kvCacheGB.toFixed(1)} GB`} />
              <Row label="compute buffer" value={`${computeBufferGB.toFixed(1)} GB`} />
              <Row label="os reserve" value={`${osReserveGB.toFixed(1)} GB`} />
              <span className="flex justify-between border-t border-hair pt-1.5 text-fg">
                <span>headroom left</span>
                <span>{fit.headroomGB.toFixed(1)} GB</span>
              </span>
            </div>
            {fit.kvSource === "estimated" && (
              <span className="text-[11px] leading-[1.45] text-fg-subtle">
                KV size estimated from parameter count — exact figures need the model's architecture metadata.
              </span>
            )}
          </div>
        )}

        <div className="flex flex-col gap-1.5 rounded-[var(--radius-card)] border border-hair bg-inset p-3">
          <span className="label-caps">On disk</span>
          <span className="data text-[11px] text-fg-muted">
            {installed ? formatBytes(model.size_bytes) : `${formatBytes(model.spec.download_bytes)} download`}
          </span>
          <span className={`data flex items-center gap-1.5 text-[10.5px] ${installed ? "text-ok" : "text-fg-subtle"}`}>
            <span className="size-[5px] rounded-full bg-current" aria-hidden />
            {installed ? "Installed" : "Not installed"}
          </span>
        </div>

        {download && download.status !== "done" ? (
          <DownloadProgressBar download={download} totalBytes={model.spec.download_bytes} />
        ) : (
          <div className="flex flex-col gap-2">
            {installed ? (
              <>
                <PrimaryButton onClick={onOpenInChat} className="h-[34px] justify-center">
                  Open in chat
                </PrimaryButton>
                <div className="flex gap-2">
                  <GhostButton onClick={onBenchmark} className="h-8 flex-1 justify-center">
                    Benchmark
                  </GhostButton>
                  <GhostButton
                    tone="danger"
                    onClick={onRemove}
                    title="Remove model"
                    className="w-[34px] shrink-0 justify-center px-0"
                  >
                    <TrashIcon className="size-3.5" />
                  </GhostButton>
                </div>
              </>
            ) : (
              <PrimaryButton onClick={onDownload} className="h-[34px] justify-center">
                <DownloadIcon className="size-3.5" />
                Download · {formatBytes(model.spec.download_bytes)}
              </PrimaryButton>
            )}
          </div>
        )}
      </div>
    </aside>
  );
}

function Spec({ label, value }: { label: string; value: string }) {
  return (
    <span className="card flex flex-col gap-1 p-2.5">
      <span className="label-caps text-[9.5px]">{label}</span>
      <span className="data text-[15px] text-fg">{value}</span>
    </span>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <span className="flex justify-between">
      <span>{label}</span>
      <span>{value}</span>
    </span>
  );
}
