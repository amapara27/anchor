import type { DownloadState, LibraryModel } from "../types";
import { formatBytes, formatContext, formatParams } from "../lib/format";
import { StatusBadge } from "./StatusBadge";
import { FitBadge } from "./FitBadge";
import { SpecPill } from "./SpecPill";
import { FitBreakdown } from "./FitBreakdown";
import { DownloadProgressBar } from "./DownloadProgressBar";
import { Chip } from "./ui/Chip";
import { Button } from "./ui/Button";
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
          <p className="label-caps truncate">
            <span className="capitalize">{model.family}</span>
            <span className="mx-1.5 text-white/20">·</span>
            {spec.publisher}
          </p>
          <div className="mt-1.5 flex items-center gap-2.5">
            <h3 className="data truncate text-lg font-semibold text-fg">{model.name}</h3>
            <StatusBadge status={model.status} />
            <FitBadge
              params_b={spec.params_b}
              quant={spec.quant}
              contextTokens={spec.context_tokens}
              totalMemoryBytes={totalMemoryBytes}
            />
          </div>
        </div>

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
              "shrink-0 cursor-pointer rounded-md p-1 transition-all focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/45 active:scale-90",
              favorite ? "text-warn" : "text-fg-subtle hover:text-fg",
            ].join(" ")}
          >
            <StarIcon className="size-4" filled={favorite} />
          </button>
        )}
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

      {/* Fit breakdown — interactive; stop clicks/keys from triggering card select. */}
      {!isDownloading && spec.params_b > 0 && (
        <div
          className="mt-3"
          onClick={(e) => e.stopPropagation()}
          onKeyDown={(e) => e.stopPropagation()}
        >
          <FitBreakdown
            params_b={spec.params_b}
            quant={spec.quant}
            contextTokens={spec.context_tokens}
            memoryBytes={totalMemoryBytes}
          />
        </div>
      )}

      {model.tags.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-1.5">
          {model.tags.map((tag) => (
            <Chip key={tag}>{tag}</Chip>
          ))}
        </div>
      )}

      {/* Footer: required memory + the row action, separated by a hairline. */}
      <div className="mt-4 flex items-center justify-between gap-3 border-t border-white/8 pt-3">
        <span className="flex items-baseline gap-1.5">
          <span className="label-caps text-[10px]">Req RAM</span>
          <span className="mono-metric text-xs text-fg">{formatBytes(spec.min_memory_bytes)}</span>
        </span>

        {/* Action — ghost in the list; the drawer carries the one accent CTA */}
        {installed ? (
          <span className="inline-flex shrink-0 items-center gap-1 text-xs font-medium text-ok">
            <CheckIcon className="size-3.5" /> Ready
          </span>
        ) : isDownloading ? (
          <Button
            variant="ghost"
            className="px-2 py-1 text-xs"
            aria-label={`Cancel download of ${model.name}`}
            onClick={(e) => {
              e.stopPropagation();
              onCancel();
            }}
          >
            <XIcon className="size-3.5" /> Cancel
          </Button>
        ) : (
          <Button
            variant="ghost"
            className="px-2 py-1 text-xs"
            aria-label={`Download ${model.name}`}
            onClick={(e) => {
              e.stopPropagation();
              onDownload();
            }}
          >
            <DownloadIcon className="size-3.5" /> Download
          </Button>
        )}
      </div>
    </div>
  );
}
