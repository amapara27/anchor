import type { DownloadState, LibraryModel } from "../types";
import { formatBytes, formatContext, formatParams } from "../lib/format";
import { StatusBadge } from "./StatusBadge";
import { FitBadge } from "./FitBadge";
import { SpecPill } from "./SpecPill";
import { DownloadProgressBar } from "./DownloadProgressBar";
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
        "focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/45",
        selected ? "border-accent/60!" : "",
      ].join(" ")}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2.5">
            <h3 className="truncate font-semibold text-fg">{model.name}</h3>
            <StatusBadge status={model.status} />
            <FitBadge minMemoryBytes={spec.min_memory_bytes} totalMemoryBytes={totalMemoryBytes} />
          </div>
          <p className="mt-0.5 truncate text-xs text-fg-subtle">
            <span className="capitalize">{model.family}</span>
            <span className="mx-1.5 text-white/20">·</span>
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
                "cursor-pointer rounded-md p-1 transition-all focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/45 active:scale-90",
                favorite ? "text-warn" : "text-fg-subtle hover:text-fg",
              ].join(" ")}
            >
              <StarIcon className="size-4" filled={favorite} />
            </button>
          )}

          {/* Primary action — one per card */}
          {installed ? (
            <span className="inline-flex shrink-0 items-center gap-1 text-xs font-medium text-ok">
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
              className="inline-flex shrink-0 cursor-pointer items-center gap-1.5 rounded-lg border border-white/12 px-2.5 py-1.5 text-xs font-medium text-fg-muted transition-colors hover:border-white/20 hover:text-fg focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/45 active:scale-[0.97]"
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
              className="inline-flex shrink-0 cursor-pointer items-center gap-1.5 rounded-lg bg-accent px-2.5 py-1.5 text-xs font-semibold text-accent-fg transition-colors hover:bg-accent/90 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/50"
            >
              <DownloadIcon className="size-3.5" /> Download
            </button>
          )}
        </div>
      </div>

      <p className="mt-3 line-clamp-2 text-sm text-fg-muted">{spec.blurb}</p>

      {isDownloading ? (
        <DownloadProgressBar download={download} totalBytes={spec.download_bytes} />
      ) : (
        <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1.5">
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
              className="rounded-md bg-white/5 px-2 py-0.5 text-[11px] font-medium text-fg-muted ring-1 ring-inset ring-white/10"
            >
              {tag}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}
