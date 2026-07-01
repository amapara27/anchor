import { formatBytes } from "../lib/format";
import type { DownloadState } from "../types";

/** Shared accent progress track — the fill bar reused by every download UI. */
export function ProgressTrack({ pct, className = "h-1.5" }: { pct: number; className?: string }) {
  return (
    <div
      className={`${className} overflow-hidden rounded-full bg-white/8`}
      role="progressbar"
      aria-valuenow={pct}
      aria-valuemin={0}
      aria-valuemax={100}
    >
      <div
        className="h-full rounded-full bg-accent transition-[width] duration-150 ease-out"
        style={{ width: `${pct}%` }}
      />
    </div>
  );
}

/** Compact download bar: label + bytes + track. Used by ModelCard and SearchResultCard. */
export function DownloadProgressBar({ download, totalBytes }: { download: DownloadState; totalBytes: number }) {
  const pct = Math.round(download.progress * 100);
  const verifying = download.status === "verifying";
  return (
    <div className="mt-3">
      <div className="mb-1.5 flex items-center justify-between text-xs">
        <span className="font-medium text-fg-muted">{verifying ? "Verifying…" : "Downloading…"}</span>
        <span className="data text-fg-subtle">
          {formatBytes(download.receivedBytes)} / {formatBytes(totalBytes)}
        </span>
      </div>
      <ProgressTrack pct={verifying ? 100 : pct} />
    </div>
  );
}
