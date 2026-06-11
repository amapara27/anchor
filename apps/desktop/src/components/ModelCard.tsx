import type { DownloadState, LibraryModel } from "../types";
import { formatBytes, formatContext, formatParams } from "../lib/format";
import { StatusBadge } from "./StatusBadge";
import { FitBadge } from "./FitBadge";
import { SpecPill } from "./SpecPill";
import { CheckIcon, ChipIcon, DownloadIcon, LayersIcon, MemoryIcon, RulerIcon, StarIcon, XIcon } from "./icons";

interface ModelCardProps {
  model: LibraryModel;
  download?: DownloadState;
  selected: boolean;
  onSelect: () => void;
  onDownload: () => void;
  onCancel: () => void;
  favorite?: boolean;
  onToggleFavorite?: () => void;
  /** Host total memory in bytes, for the hardware-fit flag. */
  totalMemoryBytes?: number | null;
}

export function ModelCard({
  model,
  download,
  selected,
  onSelect,
  onDownload,
  onCancel,
  favorite = false,
  onToggleFavorite,
  totalMemoryBytes,
}: ModelCardProps) {
  const { spec } = model;
  const installed = model.status === "installed";
  const isDownloading = download != null;

  return (
    <div
      role="button"
      tabIndex={0}
      aria-pressed={selected}
      onClick={onSelect}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onSelect();
        }
      }}
      className={[
        "card card-interactive group cursor-pointer p-4 text-left",
        "focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/40",
        selected ? "border-emerald-500/40! shadow-[0_0_20px_-8px_rgb(16_185_129/0.35)]" : "",
      ].join(" ")}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-start gap-3">
          {/* Family monogram — gives the text-only grid a visual anchor per card. */}
          <span
            className={[
              "flex size-10 shrink-0 select-none items-center justify-center rounded-lg text-sm font-semibold uppercase ring-1 transition-colors",
              installed
                ? "bg-emerald-500/10 text-emerald-300 ring-emerald-500/25"
                : "bg-slate-800/80 text-slate-400 ring-slate-700/60 group-hover:text-slate-300",
            ].join(" ")}
            aria-hidden
          >
            {model.family.slice(0, 2)}
          </span>
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <h3 className="truncate font-semibold text-slate-100">{model.name}</h3>
              <StatusBadge status={model.status} />
              <FitBadge minMemoryBytes={spec.min_memory_bytes} totalMemoryBytes={totalMemoryBytes} />
            </div>
            <p className="mt-0.5 truncate text-xs text-slate-500">
              <span className="capitalize">{model.family}</span>
              <span className="mx-1.5 text-slate-700">·</span>
              {spec.publisher}
            </p>
          </div>
        </div>

        <div className="flex shrink-0 items-center gap-1.5">
          {onToggleFavorite && (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onToggleFavorite();
              }}
              aria-pressed={favorite}
              aria-label={favorite ? `Unfavorite ${model.name}` : `Favorite ${model.name}`}
              className={[
                "cursor-pointer rounded-md p-1 transition-all focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/40 active:scale-90",
                favorite ? "text-emerald-400" : "text-slate-500 hover:text-slate-300",
              ].join(" ")}
            >
              <StarIcon className="size-4" filled={favorite} />
            </button>
          )}

          {/* Primary action — one per card */}
          {installed ? (
            <span className="inline-flex shrink-0 items-center gap-1 text-xs font-medium text-emerald-400">
              <CheckIcon className="size-3.5" /> Ready
            </span>
          ) : isDownloading ? (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onCancel();
              }}
              aria-label={`Cancel download of ${model.name}`}
              className="inline-flex shrink-0 cursor-pointer items-center gap-1.5 rounded-lg border border-slate-700 px-2.5 py-1.5 text-xs font-medium text-slate-300 transition-colors hover:border-slate-600 hover:text-slate-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/40 active:scale-[0.97]"
            >
              <XIcon className="size-3.5" /> Cancel
            </button>
          ) : (
            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                onDownload();
              }}
              aria-label={`Download ${model.name}`}
              className="glow-accent inline-flex shrink-0 cursor-pointer items-center gap-1.5 rounded-lg bg-gradient-to-b from-emerald-400 to-emerald-500 px-2.5 py-1.5 text-xs font-semibold text-slate-950 transition-all hover:from-emerald-300 hover:to-emerald-400 focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400/60 active:scale-[0.97]"
            >
              <DownloadIcon className="size-3.5" /> Download
            </button>
          )}
        </div>
      </div>

      <p className="mt-3 line-clamp-2 text-sm text-slate-400">{spec.blurb}</p>

      {isDownloading ? (
        <DownloadBar download={download} totalBytes={spec.download_bytes} />
      ) : (
        <div className="mt-3 flex flex-wrap gap-1.5">
          <SpecPill icon={<RulerIcon className="size-3.5" />} label="Parameters" value={formatParams(spec.params_b)} />
          <SpecPill icon={<LayersIcon className="size-3.5" />} label="Quantization" value={spec.quant} />
          <SpecPill icon={<ChipIcon className="size-3.5" />} label="Context" value={formatContext(spec.context_tokens)} />
          <SpecPill
            icon={<MemoryIcon className="size-3.5" />}
            label="On disk"
            value={formatBytes(model.size_bytes)}
          />
        </div>
      )}

      {model.tags.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-1.5">
          {model.tags.map((tag) => (
            <span
              key={tag}
              className="rounded-md bg-emerald-500/10 px-2 py-0.5 text-[11px] font-medium text-emerald-300 ring-1 ring-inset ring-emerald-500/20"
            >
              {tag}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

function DownloadBar({ download, totalBytes }: { download: DownloadState; totalBytes: number }) {
  const pct = Math.round(download.progress * 100);
  const verifying = download.status === "verifying";
  return (
    <div className="mt-3">
      <div className="mb-1.5 flex items-center justify-between text-xs">
        <span className="font-medium text-slate-300">{verifying ? "Verifying…" : "Downloading…"}</span>
        <span className="tabular text-slate-500">
          {formatBytes(download.receivedBytes)} / {formatBytes(totalBytes)}
        </span>
      </div>
      <div
        className="h-1.5 overflow-hidden rounded-full bg-slate-800"
        role="progressbar"
        aria-valuenow={pct}
        aria-valuemin={0}
        aria-valuemax={100}
      >
        <div
          className="h-full rounded-full bg-gradient-to-r from-emerald-500 to-emerald-400 shadow-[0_0_8px_rgb(16_185_129/0.5)] transition-[width] duration-150 ease-out"
          style={{ width: `${verifying ? 100 : pct}%` }}
        />
      </div>
    </div>
  );
}
