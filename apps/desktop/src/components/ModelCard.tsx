import type { DownloadState, LibraryModel } from "../types";
import { formatBytes, formatContext, formatParams } from "../lib/format";
import { StatusBadge } from "./StatusBadge";
import { SpecPill } from "./SpecPill";
import { ChipIcon, DownloadIcon, LayersIcon, MemoryIcon, RulerIcon, StarIcon, XIcon } from "./icons";

interface ModelCardProps {
  model: LibraryModel;
  download?: DownloadState;
  selected: boolean;
  onSelect: () => void;
  onDownload: () => void;
  onCancel: () => void;
  favorite?: boolean;
  onToggleFavorite?: () => void;
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
        "group cursor-pointer rounded-xl border bg-slate-900/50 p-4 text-left transition-colors",
        "focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/40",
        selected
          ? "border-emerald-500/40 bg-slate-900"
          : "border-slate-800 hover:border-slate-700 hover:bg-slate-900",
      ].join(" ")}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <h3 className="truncate font-semibold text-slate-100">{model.name}</h3>
            <StatusBadge status={model.status} />
          </div>
          <p className="mt-0.5 text-xs text-slate-500">
            <span className="capitalize">{model.family}</span>
            <span className="mx-1.5 text-slate-700">·</span>
            {spec.publisher}
          </p>
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
                "cursor-pointer rounded-md p-1 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/40",
                favorite ? "text-emerald-400" : "text-slate-500 hover:text-slate-300",
              ].join(" ")}
            >
              <StarIcon className="size-4" filled={favorite} />
            </button>
          )}

          {/* Primary action — one per card */}
          {installed ? (
          <span className="shrink-0 text-xs font-medium text-emerald-400">Ready</span>
        ) : isDownloading ? (
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onCancel();
            }}
            aria-label={`Cancel download of ${model.name}`}
            className="inline-flex shrink-0 cursor-pointer items-center gap-1.5 rounded-lg border border-slate-700 px-2.5 py-1.5 text-xs font-medium text-slate-300 transition-colors hover:border-slate-600 hover:text-slate-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/40"
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
            className="inline-flex shrink-0 cursor-pointer items-center gap-1.5 rounded-lg bg-emerald-500/90 px-2.5 py-1.5 text-xs font-semibold text-slate-950 transition-colors hover:bg-emerald-400 focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400/60"
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
          className="h-full rounded-full bg-emerald-500 transition-[width] duration-150 ease-out"
          style={{ width: `${verifying ? 100 : pct}%` }}
        />
      </div>
    </div>
  );
}
