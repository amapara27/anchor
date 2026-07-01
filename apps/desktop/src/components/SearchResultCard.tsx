import type { DownloadState, LibraryModel, ScoredModel } from "../types";
import { formatContext, formatParams } from "../lib/format";
import { StatusBadge } from "./StatusBadge";
import { FitBadge } from "./FitBadge";
import { SpecPill } from "./SpecPill";
import { DownloadProgressBar } from "./DownloadProgressBar";
import { CheckIcon, ChipIcon, DownloadIcon, LayersIcon, RulerIcon, XIcon } from "./icons";

const GB = 1024 ** 3;

interface SearchResultCardProps {
  result: ScoredModel;
  /** 1-based position in the ranked results, shown as "#1". */
  rank: number;
  /** Score ÷ top score (0–1), drives the relevance bar width. */
  relative: number;
  /** Live library row for this model, when found — gives real install state. */
  libraryModel?: LibraryModel;
  download?: DownloadState;
  onDownload: () => void;
  onCancel: () => void;
  totalMemoryBytes?: number | null;
}

export function SearchResultCard({
  result,
  rank,
  relative,
  libraryModel,
  download,
  onDownload,
  onCancel,
  totalMemoryBytes,
}: SearchResultCardProps) {
  const { profile } = result;
  const installed = libraryModel?.status === "installed";
  const isDownloading = download != null;

  // The "why": the authored profile prose. The keyword tail (after "Keywords:")
  // is rendered as chips below, so strip it here. Kept as a single text slot so a
  // future per-search, model-generated rationale can drop in unchanged.
  const why = profile.profile.split("Keywords:")[0].trim();

  return (
    <div className="card p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2.5">
            <span className="data shrink-0 text-xs font-semibold text-accent-text">#{rank}</span>
            <h3 className="truncate font-semibold text-fg">{profile.name}</h3>
            <StatusBadge status={libraryModel?.status ?? "available"} />
            <FitBadge minMemoryBytes={profile.min_memory_gb * GB} totalMemoryBytes={totalMemoryBytes} />
          </div>
          <p className="mt-0.5 truncate text-xs text-fg-subtle">
            <span className="capitalize">{profile.family}</span>
            <span className="mx-1.5 text-white/20">·</span>
            {profile.publisher}
          </p>
        </div>

        {/* Primary action — one per card, reusing the library's download flow. */}
        <div className="shrink-0">
          {installed ? (
            <span className="inline-flex items-center gap-1 text-xs font-medium text-ok">
              <CheckIcon className="size-3.5" /> Ready
            </span>
          ) : isDownloading ? (
            <button
              type="button"
              onClick={onCancel}
              aria-label={`Cancel download of ${profile.name}`}
              className="inline-flex cursor-pointer items-center gap-1.5 rounded-lg border border-white/12 px-2.5 py-1.5 text-xs font-medium text-fg-muted transition-colors hover:border-white/20 hover:text-fg focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/45 active:scale-[0.97]"
            >
              <XIcon className="size-3.5" /> Cancel
            </button>
          ) : (
            <button
              type="button"
              onClick={onDownload}
              aria-label={`Download ${profile.name}`}
              className="inline-flex cursor-pointer items-center gap-1.5 rounded-lg bg-accent px-2.5 py-1.5 text-xs font-semibold text-accent-fg transition-colors hover:bg-accent/90 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/50 active:scale-[0.97]"
            >
              <DownloadIcon className="size-3.5" /> Download
            </button>
          )}
        </div>
      </div>

      {/* Relevance: a slim bar + the raw cosine score (honest, not a fake %). */}
      <div className="mt-3 flex items-center gap-2.5">
        <span className="text-[11px] font-medium uppercase tracking-wide text-fg-subtle">Relevance</span>
        <div
          className="h-1.5 flex-1 overflow-hidden rounded-full bg-white/8"
          role="progressbar"
          aria-label={`Relevance to your search: ${result.score.toFixed(2)}`}
          aria-valuenow={Math.round(relative * 100)}
          aria-valuemin={0}
          aria-valuemax={100}
        >
          <div className="h-full rounded-full bg-accent" style={{ width: `${Math.round(relative * 100)}%` }} />
        </div>
        <span className="data text-xs text-fg-subtle">{result.score.toFixed(2)}</span>
      </div>

      {/* The "why" — what this model is good for. */}
      <p className="mt-3 text-sm text-fg-muted">{why}</p>

      {isDownloading ? (
        <DownloadProgressBar download={download} totalBytes={profile.download_gb * GB} />
      ) : (
        <>
          {profile.use_cases.length > 0 && (
            <div className="mt-3 flex flex-wrap gap-1.5">
              {profile.use_cases.map((tag) => (
                <span
                  key={tag}
                  className="rounded-md bg-white/5 px-2 py-0.5 text-[11px] font-medium text-fg-muted ring-1 ring-inset ring-white/10"
                >
                  {tag}
                </span>
              ))}
            </div>
          )}

          <div className="mt-3 flex flex-wrap gap-x-4 gap-y-1.5">
            <SpecPill icon={<RulerIcon className="size-3.5" />} label="Parameters" value={formatParams(profile.params_b)} />
            <SpecPill icon={<LayersIcon className="size-3.5" />} label="Quantization" value={profile.quant} />
            <SpecPill icon={<ChipIcon className="size-3.5" />} label="Context" value={formatContext(profile.context_tokens)} />
          </div>
        </>
      )}
    </div>
  );
}
