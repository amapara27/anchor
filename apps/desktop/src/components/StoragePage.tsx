import { useMemo, useState } from "react";
import type { LibraryModel, StorageScan } from "../types";
import { useModels } from "../lib/useModels";
import { useStorageScan } from "../lib/useStorageScan";
import { formatBytes } from "../lib/format";
import { getLastUsed, isStale, STALE_DAYS } from "../lib/lastUsed";
import { PageHeader, GhostButton } from "./PageHeader";
import { StatCard } from "./ui/StatCard";
import { SegmentedBar, type Segment } from "./ui/SegmentedBar";
import { ConfirmDialog } from "./ui/ConfirmDialog";
import { CheckIcon, RefreshIcon } from "./icons";

/** Palette for the disk map, walked in order per model family. */
const FAMILY_COLORS = [
  "var(--accent)",
  "var(--accent-line)",
  "var(--hair2)",
  "var(--hair)",
  "var(--inset)",
];

const ROW_COLUMNS = "grid-cols-[26px_minmax(0,1fr)_90px_128px_120px]";

/** Last-used date, e.g. "Mar 3, 2026", or "never" when untracked. */
function formatLastUsed(ms: number | null): string {
  if (ms == null) return "never";
  const days = Math.floor((Date.now() - ms) / 86_400_000);
  if (days === 0) return "today";
  if (days === 1) return "yesterday";
  if (days < 30) return `${days} days ago`;
  return new Date(ms).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });
}

/**
 * Storage: what the installed weights cost on disk, where they live, and what
 * can be reclaimed.
 *
 * Installed weights come from `useModels()` + `lastUsed`; dedupe savings,
 * on-disk locations and orphaned-blob housekeeping come from a real scan of
 * Ollama's store (`useStorageScan`, backed by `anchor_hub::storage`) — Ollama
 * content-addresses blobs by digest, so shared layers are already deduped on
 * disk at pull time, and this only reports that truth rather than computing
 * anything new.
 */
export function StoragePage() {
  const { models, error, removeModel } = useModels();
  const { scan, loading: scanning, refresh: rescan, clean } = useStorageScan();
  const [selected, setSelected] = useState<Record<string, boolean>>({});
  const [pendingRemove, setPendingRemove] = useState<LibraryModel[] | null>(null);
  const [pendingClean, setPendingClean] = useState<StorageScan | null>(null);

  const rows = useMemo(
    () =>
      models
        .filter((m) => m.status === "installed")
        .map((m) => ({ model: m, lastUsed: getLastUsed(m.id), stale: isStale(m.id, m.modified_at) }))
        .sort((a, b) => (b.model.size_bytes ?? 0) - (a.model.size_bytes ?? 0)),
    [models],
  );

  const totalBytes = rows.reduce((sum, r) => sum + (r.model.size_bytes ?? 0), 0);
  const staleRows = rows.filter((r) => r.stale);
  // Nominal sum, not blob-aware: a stale model whose blobs are also referenced
  // by a kept model would actually free less than this on removal. Doing that
  // right needs a per-model blob-digest join against `scan`, a second feature
  // on top of the aggregate scan below — deferred, not silently wrong-by-design.
  const reclaimBytes = staleRows.reduce((sum, r) => sum + (r.model.size_bytes ?? 0), 0);

  // Disk map: one segment per model family, largest first.
  const diskMap = useMemo<Segment[]>(() => {
    const byFamily = new Map<string, number>();
    for (const { model } of rows) {
      byFamily.set(model.family, (byFamily.get(model.family) ?? 0) + (model.size_bytes ?? 0));
    }
    return [...byFamily.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([family, bytes], i) => ({
        label: family,
        fraction: totalBytes > 0 ? bytes / totalBytes : 0,
        color: FAMILY_COLORS[i % FAMILY_COLORS.length],
        detail: formatBytes(bytes),
      }));
  }, [rows, totalBytes]);

  const selectedIds = Object.keys(selected).filter((id) => selected[id]);
  const selectedBytes = rows
    .filter((r) => selected[r.model.id])
    .reduce((sum, r) => sum + (r.model.size_bytes ?? 0), 0);

  return (
    <>
      <PageHeader
        eyebrow="Manage"
        title="Storage"
        subtitle="What every installed model costs on disk, and what you can safely get back."
        actions={
          <GhostButton onClick={() => rescan()} disabled={scanning} title="Re-walk Ollama's on-disk store">
            <RefreshIcon className={`size-3.5 ${scanning ? "animate-spin" : ""}`} />
            Rescan disk
          </GhostButton>
        }
      />

      {error && <p className="text-sm text-danger">{error}</p>}

      <section className="card flex flex-col gap-3 p-4">
        <div className="flex flex-wrap items-baseline gap-2.5">
          <span className="label-caps">Disk map · by model family</span>
          <span className="data ml-auto text-[11.5px] text-fg-muted">
            {formatBytes(totalBytes)} of models · {rows.length} installed
          </span>
        </div>
        {diskMap.length > 0 ? (
          <SegmentedBar segments={diskMap} height={34} legend />
        ) : (
          <p className="text-sm text-fg-subtle">No models installed.</p>
        )}
      </section>

      <div className="grid grid-cols-[minmax(0,1fr)_minmax(0,2fr)] gap-2.5">
        <StatCard
          label="Reclaimable"
          value={formatBytes(reclaimBytes)}
          tone={reclaimBytes > 0 ? "warn" : "default"}
          sub={
            staleRows.length > 0
              ? `${staleRows.length} ${staleRows.length === 1 ? "model" : "models"} unused for ${STALE_DAYS}+ days`
              : "Everything's been used recently."
          }
        />
        <StatCard
          label="Dedupe savings"
          value={formatBytes(scan?.dedup_savings_bytes ?? 0)}
          sub={scan ? "from blobs already shared across installed tags" : scanning ? "Scanning…" : "Rescan disk to compute"}
        />
      </div>

      <section className="card overflow-hidden">
        <div className="flex items-center gap-3 border-b border-hair px-4 py-3">
          <span className="text-[13.5px] font-semibold text-fg">Installed weights</span>
          <span className="data text-[11px] text-fg-subtle">largest first</span>
          {selectedIds.length > 0 ? (
            <span className="ml-auto flex items-center gap-2.5">
              <span className="data text-[11.5px] text-accent-text">
                {selectedIds.length} selected · frees {formatBytes(selectedBytes)}
              </span>
              <GhostButton className="h-7 text-xs" onClick={() => setSelected({})}>
                Clear
              </GhostButton>
              <GhostButton
                tone="danger"
                className="h-7 text-xs"
                onClick={() => setPendingRemove(rows.filter((r) => selected[r.model.id]).map((r) => r.model))}
              >
                Remove selected
              </GhostButton>
            </span>
          ) : (
            staleRows.length > 0 && (
              <GhostButton
                className="ml-auto h-7 text-xs"
                onClick={() => setSelected(Object.fromEntries(staleRows.map((r) => [r.model.id, true])))}
              >
                Select stale ({staleRows.length})
              </GhostButton>
            )
          )}
        </div>

        <div className={`label-caps grid ${ROW_COLUMNS} gap-3 border-b border-hair bg-inset px-4 py-2.5`}>
          <span />
          <span>Model</span>
          <span className="text-right">Size</span>
          <span>Last used</span>
          <span>Family</span>
        </div>

        {rows.length === 0 ? (
          <p className="px-4 py-6 text-sm text-fg-subtle">No models installed.</p>
        ) : (
          rows.map(({ model, lastUsed, stale }) => {
            const checked = !!selected[model.id];
            return (
              <div
                key={model.id}
                onClick={() => setSelected((s) => ({ ...s, [model.id]: !s[model.id] }))}
                className={[
                  `grid ${ROW_COLUMNS} cursor-pointer items-center gap-3 border-b border-hair px-4 py-2.5`,
                  "transition-colors duration-150 ease-out hover:bg-inset",
                  checked ? "bg-accent-soft" : "",
                ].join(" ")}
              >
                <span
                  role="checkbox"
                  aria-checked={checked}
                  aria-label={`Select ${model.name}`}
                  className={[
                    "flex size-[15px] items-center justify-center rounded border transition-colors duration-150 ease-out",
                    checked ? "border-accent bg-accent" : "border-hair2",
                  ].join(" ")}
                >
                  {checked && <CheckIcon className="size-2.5 text-accent-fg" />}
                </span>
                <span className="flex min-w-0 items-center gap-2.5">
                  <span className="data truncate text-[12.5px] text-fg">{model.name}</span>
                  {stale && (
                    <span className="data shrink-0 rounded-full border border-hair px-1.5 py-px text-[9.5px] uppercase tracking-[0.06em] text-warn">
                      stale
                    </span>
                  )}
                </span>
                <span className="data text-right text-[11.5px] text-fg-muted">
                  {formatBytes(model.size_bytes)}
                </span>
                <span className={`data text-[11px] ${stale ? "text-warn" : "text-fg-muted"}`}>
                  {formatLastUsed(lastUsed)}
                </span>
                <span className="data truncate text-[11px] text-fg-subtle">{model.family}</span>
              </div>
            );
          })
        )}
      </section>

      <div className="grid grid-cols-2 gap-2.5">
        <section className="card flex flex-col gap-3 p-4">
          <span className="label-caps">Locations</span>
          {scan ? (
            <div className="flex flex-col gap-2 text-[11.5px]">
              <span className="flex items-center justify-between gap-3">
                <span className="text-fg-subtle">Store</span>
                <span className="data truncate text-fg" title={scan.root}>
                  {scan.root}
                </span>
              </span>
              <span className="flex items-center justify-between">
                <span className="text-fg-subtle">Blobs</span>
                <span className="data text-fg-muted">{formatBytes(scan.blobs_bytes)}</span>
              </span>
              <span className="flex items-center justify-between">
                <span className="text-fg-subtle">Manifests</span>
                <span className="data text-fg-muted">{formatBytes(scan.manifests_bytes)}</span>
              </span>
            </div>
          ) : (
            <p className="text-sm text-fg-subtle">
              {scanning ? "Scanning…" : "No Ollama model store found yet — pull a model first."}
            </p>
          )}
        </section>

        <section className="card flex flex-col gap-3 p-4">
          <span className="label-caps">Housekeeping</span>
          {scan && scan.orphaned_blobs.length > 0 ? (
            <>
              <p className="text-[11.5px] leading-[1.5] text-fg-subtle">
                {scan.orphaned_blobs.length} orphaned {scan.orphaned_blobs.length === 1 ? "blob" : "blobs"} — not
                referenced by any installed model or tag (usually left behind by an interrupted pull). Safe to
                delete.
              </p>
              <GhostButton tone="danger" className="h-7 self-start text-xs" onClick={() => setPendingClean(scan)}>
                Clean up · frees {formatBytes(scan.orphaned_bytes)}
              </GhostButton>
            </>
          ) : scan && scan.unreadable_manifests > 0 ? (
            <p className="text-[11.5px] leading-[1.5] text-warn">
              Couldn&rsquo;t read {scan.unreadable_manifests}{" "}
              {scan.unreadable_manifests === 1 ? "manifest" : "manifests"} in the model store, so which blobs are
              still in use can&rsquo;t be determined. Cleanup is off — deleting against a partial picture could
              remove data an installed model still needs.
            </p>
          ) : (
            <p className="text-[11.5px] text-fg-subtle">
              {scan
                ? "No orphaned blobs — everything on disk is referenced."
                : scanning
                  ? "Scanning…"
                  : "Rescan disk to check for orphaned blobs."}
            </p>
          )}
        </section>
      </div>

      <ConfirmDialog
        open={pendingRemove != null}
        title={pendingRemove && pendingRemove.length > 1 ? "Remove models?" : "Remove model?"}
        body={
          pendingRemove
            ? `${pendingRemove.map((m) => m.name).join(", ")} will be deleted from Ollama, freeing ${formatBytes(
                pendingRemove.reduce((sum, m) => sum + (m.size_bytes ?? 0), 0),
              )}. This cannot be undone.`
            : ""
        }
        confirmLabel="Remove"
        onConfirm={() => {
          pendingRemove?.forEach((m) => removeModel(m.id));
          setPendingRemove(null);
          setSelected({});
        }}
        onCancel={() => setPendingRemove(null)}
      />

      <ConfirmDialog
        open={pendingClean != null}
        title="Clean up orphaned blobs?"
        body={
          pendingClean
            ? `Deletes ${pendingClean.orphaned_blobs.length} blob file${pendingClean.orphaned_blobs.length === 1 ? "" : "s"} nothing installed points at, freeing ${formatBytes(pendingClean.orphaned_bytes)}. This cannot be undone.`
            : ""
        }
        confirmLabel="Clean up"
        onConfirm={() => {
          if (pendingClean) void clean(pendingClean);
          setPendingClean(null);
        }}
        onCancel={() => setPendingClean(null)}
      />
    </>
  );
}
