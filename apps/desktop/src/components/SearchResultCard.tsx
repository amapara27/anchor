import type { DownloadState, HardwareProfile, LibraryModel, ScoredModel } from "../types";
import { formatContext, formatParams } from "../lib/format";
import { hardwareHint, type HardwareHint } from "../lib/hint";
import { fitContext } from "../lib/fit";
import { StatusBadge } from "./StatusBadge";
import { SpecPill } from "./SpecPill";
import { StatCard } from "./ui/StatCard";
import { Chip } from "./ui/Chip";
import { DownloadProgressBar } from "./DownloadProgressBar";
import { CheckIcon, ChipIcon, DownloadIcon, LayersIcon, RulerIcon, SparkleIcon, WarningIcon, XIcon } from "./icons";

const GB = 1024 ** 3;

interface SearchResultCardProps {
  result: ScoredModel;
  /** 1-based position in the ranked results, drives the qualitative label. */
  rank: number;
  /** When false, results are shown as a "related models" browse, not matches. */
  confident?: boolean;
  /** Full-width top-match layout with the metric strip and "why" block. */
  hero?: boolean;
  /** Live library row for this model, when found — gives real install state. */
  libraryModel?: LibraryModel;
  download?: DownloadState;
  onDownload: () => void;
  onCancel: () => void;
  /** Host profile — memory decides the fit, chip decides the speed. */
  hardware?: HardwareProfile | null;
}

/**
 * The moat, at the point of purchase: whether this model fits this Mac and how
 * fast it will run. Always renders — on the screen where you choose what to
 * download, "fits comfortably" is signal too, and a badge that appears only on
 * bad news reads as missing data rather than good news (the reason the old
 * warn-only FitBadge was replaced here).
 */
function HardwareLine({ hint, className = "" }: { hint: HardwareHint; className?: string }) {
  if (hint.tier === "unknown") return null;
  const warn = hint.tier !== "ok";
  return (
    <span
      className={`inline-flex items-center gap-1.5 text-xs ${className}`}
      title={hint.tps?.source === "measured" ? "Measured on this Mac" : "Estimated for this Mac"}
    >
      {warn ? (
        <WarningIcon className={`size-3 shrink-0 ${hint.tone}`} />
      ) : (
        <span className="size-1.5 shrink-0 rounded-full bg-ok" aria-hidden />
      )}
      <span className={`font-medium ${hint.tone}`}>{hint.label}</span>
      {hint.detail && (
        <>
          <span className="text-fg-subtle" aria-hidden>
            ·
          </span>
          <span className="data text-fg-muted">{hint.detail}</span>
        </>
      )}
    </span>
  );
}

/**
 * Qualitative rank instead of a raw cosine number. When we're not confident the
 * whole set is "Related"; otherwise the top hit leads and the rest are strong.
 */
function rankLabel(rank: number, confident: boolean): string {
  if (!confident) return "Related";
  if (rank === 1) return "Top match";
  if (rank === 2) return "Strong";
  return "Related";
}

export function SearchResultCard({
  result,
  rank,
  confident = true,
  hero = false,
  libraryModel,
  download,
  onDownload,
  onCancel,
  hardware,
}: SearchResultCardProps) {
  const { profile } = result;
  const installed = libraryModel?.status === "installed";
  const isDownloading = download != null;

  // Prefer the installed model's real GGUF metadata and on-disk size; fall back
  // to the catalog figures for anything not downloaded yet. The catalog now
  // carries architecture metadata of its own, so an available model gets the
  // same exact KV math as an installed one rather than a size bucket.
  const hint = hardwareHint(
    {
      id: profile.id,
      params_b: profile.params_b,
      quant: profile.quant,
      contextTokens: profile.context_tokens,
      arch: libraryModel?.arch ?? profile.arch,
      sizeBytes: libraryModel?.size_bytes,
    },
    hardware,
  );
  // The context the fit was judged at — named on the stat so the number isn't
  // read as a figure for the model's full advertised window.
  const judgedContext = fitContext(profile.context_tokens);

  // The "why": the authored profile prose. The keyword tail (after "Keywords:")
  // is rendered as chips below, so strip it here. Kept as a single text slot so a
  // future per-search, model-generated rationale can drop in unchanged.
  const why = profile.profile.split("Keywords:")[0].trim();

  if (hero) {
    return (
      <div className="card p-6">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="label-caps truncate">
              <span className="capitalize">{profile.family}</span>
              <span className="mx-1.5 text-fg-subtle">·</span>
              {profile.publisher}
            </p>
            <div className="mt-1.5 flex items-center gap-2.5">
              <h3 className="data truncate text-2xl font-semibold tracking-tight text-fg">{profile.name}</h3>
              <StatusBadge status={libraryModel?.status ?? "available"} />
            </div>
            <HardwareLine hint={hint} className="mt-2" />
          </div>
          {/* Relevance badge — raw cosine in mono, no fake percentages. */}
          <span className="mono-metric inline-flex shrink-0 items-center gap-1.5 rounded-full px-2.5 py-1 text-xs text-accent-text ring-1 ring-inset ring-accent/30">
            <SparkleIcon className="size-3.5" />
            {rankLabel(rank, confident)} · {result.score.toFixed(2)}
          </span>
        </div>

        <div className="mt-4 grid grid-cols-2 gap-2 lg:grid-cols-4">
          <StatCard recessed label="Size" value={`${profile.download_gb.toFixed(1)}`} sub="GB download" compact />
          <StatCard
            recessed
            label="Req. RAM"
            value={`${hint.fit.breakdown.totalNeededGB.toFixed(1)}`}
            sub={`GB at ${formatContext(judgedContext)}`}
            compact
          />
          <StatCard recessed label="Quant" value={profile.quant} compact />
          <StatCard recessed label="Context" value={formatContext(profile.context_tokens)} compact />
        </div>

        <div className="mt-4">
          <span className="label-caps">Why this model?</span>
          <p className="mt-1.5 text-sm leading-relaxed text-fg-muted">{why}</p>
        </div>

        {profile.use_cases.length > 0 && (
          <div className="mt-3 flex flex-wrap gap-1.5">
            {profile.use_cases.map((tag) => (
              <Chip key={tag}>{tag}</Chip>
            ))}
          </div>
        )}

        {isDownloading ? (
          <DownloadProgressBar download={download} totalBytes={profile.download_gb * GB} />
        ) : (
          <div className="mt-5 flex items-center gap-2 border-t border-hair pt-4">
            <ActionButton
              installed={installed}
              isDownloading={isDownloading}
              name={profile.name}
              onDownload={onDownload}
              onCancel={onCancel}
              primary
            />
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="card p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex items-center gap-2.5">
            <h3 className="data truncate font-semibold text-fg">{profile.name}</h3>
            <StatusBadge status={libraryModel?.status ?? "available"} />
            <HardwareLine hint={hint} />
          </div>
          <p className="label-caps mt-1 truncate text-[10px]">
            <span className="capitalize">{profile.family}</span>
            <span className="mx-1.5 text-fg-subtle">·</span>
            {profile.publisher}
          </p>
        </div>
        <span className="mono-metric shrink-0 text-xs text-fg-subtle" title="Relevance (cosine)">
          {rankLabel(rank, confident)} · {result.score.toFixed(2)}
        </span>
      </div>

      {/* Capability badges: what the model can do (one per capability). */}
      {/* ponytail: shows the model's own capabilities, not the query-matched
          subset — for a filtered vision query these already are the match. */}
      {profile.capabilities.length > 0 && (
        <div className="mt-3 flex flex-wrap gap-1.5">
          {profile.capabilities.map((cap) => (
            <Chip key={cap} className="capitalize">
              {cap}
            </Chip>
          ))}
        </div>
      )}

      <p className="mt-3 line-clamp-3 text-sm text-fg-muted">{why}</p>

      {isDownloading ? (
        <DownloadProgressBar download={download} totalBytes={profile.download_gb * GB} />
      ) : (
        <div className="mt-4 flex flex-wrap items-center justify-between gap-3 border-t border-hair pt-3">
          <div className="flex flex-wrap gap-x-4 gap-y-1.5">
            <SpecPill icon={<RulerIcon className="size-3.5" />} label="Parameters" value={formatParams(profile.params_b)} />
            <SpecPill icon={<LayersIcon className="size-3.5" />} label="Quantization" value={profile.quant} />
            <SpecPill icon={<ChipIcon className="size-3.5" />} label="Context" value={formatContext(profile.context_tokens)} />
          </div>
          <ActionButton
            installed={installed}
            isDownloading={isDownloading}
            name={profile.name}
            onDownload={onDownload}
            onCancel={onCancel}
          />
        </div>
      )}
    </div>
  );
}

/** Ready / Cancel / Download; `primary` only on the hero — one accent CTA per view. */
function ActionButton({
  installed,
  isDownloading,
  name,
  onDownload,
  onCancel,
  primary = false,
}: {
  installed: boolean;
  isDownloading: boolean;
  name: string;
  onDownload: () => void;
  onCancel: () => void;
  primary?: boolean;
}) {
  if (installed) {
    return (
      <span className="inline-flex items-center gap-1 text-xs font-medium text-ok">
        <CheckIcon className="size-3.5" /> Ready
      </span>
    );
  }
  if (isDownloading) {
    return (
      <button
        type="button"
        onClick={onCancel}
        aria-label={`Cancel download of ${name}`}
        className="inline-flex cursor-pointer items-center gap-1.5 rounded-lg border border-hair px-2.5 py-1.5 text-xs font-medium text-fg-muted transition-colors hover:border-hair2 hover:text-fg focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/45 active:scale-[0.97]"
      >
        <XIcon className="size-3.5" /> Cancel
      </button>
    );
  }
  return (
    <button
      type="button"
      onClick={onDownload}
      aria-label={`Download ${name}`}
      className={[
        "inline-flex cursor-pointer items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-xs font-semibold transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/50 active:scale-[0.97]",
        primary
          ? "bg-accent text-accent-fg hover:bg-accent/90"
          : "border border-hair font-medium text-fg-muted hover:border-hair2 hover:text-fg",
      ].join(" ")}
    >
      <DownloadIcon className="size-3.5" /> Download
    </button>
  );
}
