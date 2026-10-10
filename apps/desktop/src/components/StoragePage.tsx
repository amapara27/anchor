import { useMemo, useState } from "react";
import type { LibraryModel, StorageScan } from "../types";
import { useModels } from "../lib/useModels";
import { useStorageScan } from "../lib/useStorageScan";
import { formatBytes } from "../lib/format";
import { getLastUsed, isStale, STALE_DAYS } from "../lib/lastUsed";
import { PageHeader, GhostButton } from "./PageHeader";
import { SegmentedBar, type Segment } from "./ui/SegmentedBar";
import { ConfirmDialog } from "./ui/ConfirmDialog";
import { RefreshIcon } from "./icons";

/** Palette for the disk map, walked in order per model family. */
const FAMILY_COLORS = [
  "var(--accent)",
  "var(--accent-line)",
  "var(--hair2)",
  "var(--hair)",
  "var(--inset)",
];

const ROW_COLUMNS = "grid-cols-[22px_minmax(0,1fr)_90px_140px_110px]";

/** A measured zero reads as "0 B"; "—" is reserved for unknown. */
const sized = (bytes: number) => (bytes > 0 ? formatBytes(bytes) : "0 B");

/** Last-used date, e.g. "Mar 3, 2026", or "never" when untracked. */
function formatLastUsed(ms: number | null): string {
  if (ms == null) return "not recorded";
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
        title="Storage"
        actions={
          <GhostButton onClick={() => rescan()} disabled={scanning} title="Re-walk Ollama's on-disk store">
            <RefreshIcon className={`size-3.5 ${scanning ? "animate-spin" : ""}`} />
            Rescan disk
          </GhostButton>
        }
      />

      {error && <p className="text-sm text-danger">{error}</p>}

      <div className="stat-strip" aria-label="Storage summary">
        <div>
          <span className="stat-k">On disk</span>
          <span className="stat-v">{sized(totalBytes)}</span>
          <span className="stat-sub">{rows.length} installed {rows.length === 1 ? "model" : "models"}</span>
        </div>
        <div>
          <span className="stat-k">Unused model sizes</span>
          <span className={`stat-v ${reclaimBytes > 0 ? "text-warn" : ""}`}>{sized(reclaimBytes)}</span>
          <span className="stat-sub" title={staleRows.length > 0 ? `Not used in Anchor for ${STALE_DAYS}+ days` : undefined}>
            {staleRows.length > 0
              ? `${staleRows.length} not used for ${STALE_DAYS}+ days`
              : "Everything's been used recently."}
          </span>
        </div>
        <div>
          <span className="stat-k">Dedupe savings</span>
          <span className="stat-v">{scan ? sized(scan.dedup_savings_bytes) : "—"}</span>
          <span className="stat-sub">{scan ? "shared blobs across tags" : scanning ? "Scanning…" : "Rescan disk to compute"}</span>
        </div>
        <div>
          <span className="stat-k">Orphaned blobs</span>
          <span className="stat-v">{scan ? sized(scan.orphaned_bytes) : "—"}</span>
          <span className="stat-sub">{scan ? `${scan.orphaned_blobs.length} ${scan.orphaned_blobs.length === 1 ? "file" : "files"}` : scanning ? "Scanning…" : "Rescan disk to check"}</span>
        </div>
      </div>

      <section className="flex flex-col gap-2.5">
        <div className="flex flex-wrap items-baseline gap-2.5">
          <h2 className="text-[15px] font-semibold tracking-tight">Disk map</h2>
          <span className="text-xs text-fg-muted">by model family</span>
        </div>
        {diskMap.length > 0 ? (
          <SegmentedBar segments={diskMap} height={6} legend />
        ) : (
          <p className="text-sm text-fg-muted">No models installed.</p>
        )}
      </section>

      <section className="flex flex-col gap-2.5">
        <div className="flex min-h-8 flex-wrap items-center gap-3">
          <h2 className="text-[15px] font-semibold tracking-tight">Installed weights</h2>
          <span className="text-xs text-fg-muted">largest first</span>
          {selectedIds.length > 0 ? (
            <span className="ml-auto flex items-center gap-2.5">
              <span className="data text-[12px] text-fg-muted">
                <span className="text-fg">{selectedIds.length}</span> selected · {formatBytes(selectedBytes)}
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

        <div className="overflow-hidden rounded-card border border-hair">
          <div className={`th grid ${ROW_COLUMNS} gap-3 border-b border-hair bg-surface px-4 py-2`}>
            <span />
            <span>model</span>
            <span className="text-right">size</span>
            <span>last used in Anchor</span>
            <span>family</span>
          </div>

          {rows.length === 0 ? (
            <p className="px-4 py-6 text-sm text-fg-muted">No models installed.</p>
          ) : (
            rows.map(({ model, lastUsed, stale }) => {
              const checked = !!selected[model.id];
              return (
                <div
                  key={model.id}
                  onClick={() => setSelected((s) => ({ ...s, [model.id]: !s[model.id] }))}
                  className={[
                    `grid ${ROW_COLUMNS} min-h-11 cursor-pointer items-center gap-3 border-b border-hair px-4 py-2 last:border-b-0`,
                    "transition-colors duration-150 ease-out",
                    checked ? "bg-accent-soft" : "hover:bg-inset",
                  ].join(" ")}
                >
                  <input
                    type="checkbox"
                    checked={checked}
                    aria-label={`Select ${model.name}`}
                    onClick={e => e.stopPropagation()}
                    onChange={e => setSelected(s => ({ ...s, [model.id]: e.target.checked }))}
                    className="size-[14px] cursor-pointer"
                  />
                  <span className="flex min-w-0 items-baseline gap-2.5">
                    <span className="truncate text-[13px] font-medium text-fg">{model.name}</span>
                    <span className="data truncate text-[11px] text-fg-subtle">{model.id}</span>
                    {stale && <span className="shrink-0 text-[11px] text-warn">stale</span>}
                  </span>
                  <span className="data text-right text-[12px] text-fg-muted">
                    {formatBytes(model.size_bytes)}
                  </span>
                  <span className={`data text-[12px] ${stale ? "text-warn" : "text-fg-muted"}`}>
                    {formatLastUsed(lastUsed)}
                  </span>
                  <span className="data truncate text-[12px] text-fg-muted">{model.family}</span>
                </div>
              );
            })
          )}
        </div>
      </section>

      <div className="grid gap-x-8 gap-y-6 border-t border-hair pt-5 md:grid-cols-2">
        <section className="flex flex-col gap-2.5">
          <h2 className="text-[13px] font-medium text-fg">Locations</h2>
          {scan ? (
            <dl className="flex flex-col text-[13px]">
              <div className="flex items-baseline justify-between gap-3 py-1">
                <dt className="text-fg-muted">Store</dt>
                <dd className="data truncate text-[12px] text-fg" title={scan.root}>{scan.root}</dd>
              </div>
              <div className="flex items-baseline justify-between gap-3 py-1">
                <dt className="text-fg-muted">Blobs</dt>
                <dd className="data text-[12px] text-fg">{formatBytes(scan.blobs_bytes)}</dd>
              </div>
              <div className="flex items-baseline justify-between gap-3 py-1">
                <dt className="text-fg-muted">Manifests</dt>
                <dd className="data text-[12px] text-fg">{formatBytes(scan.manifests_bytes)}</dd>
              </div>
            </dl>
          ) : (
            <p className="text-[13px] text-fg-muted">
              {scanning ? "Scanning…" : "No Ollama model store found yet — pull a model first."}
            </p>
          )}
        </section>

        <section className="flex flex-col gap-2.5">
          <h2 className="text-[13px] font-medium text-fg">Housekeeping</h2>
          {scan && scan.orphaned_blobs.length > 0 ? (
            <>
              <p className="text-[13px] leading-[1.5] text-fg-muted">
                {scan.orphaned_blobs.length} orphaned {scan.orphaned_blobs.length === 1 ? "blob" : "blobs"} — not
                referenced by any installed model or tag (usually left behind by an interrupted pull). Safe to
                delete.
              </p>
              <GhostButton tone="danger" className="h-7 self-start text-xs" onClick={() => setPendingClean(scan)}>
                Clean up · frees {formatBytes(scan.orphaned_bytes)}
              </GhostButton>
            </>
          ) : scan && scan.unreadable_manifests > 0 ? (
            <p className="text-[13px] leading-[1.5] text-warn">
              Couldn&rsquo;t read {scan.unreadable_manifests}{" "}
              {scan.unreadable_manifests === 1 ? "manifest" : "manifests"} in the model store, so which blobs are
              still in use can&rsquo;t be determined. Cleanup is off — deleting against a partial picture could
              remove data an installed model still needs.
            </p>
          ) : (
            <p className="text-[13px] text-fg-muted">
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
              ? `${pendingRemove.map((m) => m.name).join(", ")} will be deleted from Ollama. Their model sizes total ${formatBytes(
                pendingRemove.reduce((sum, m) => sum + (m.size_bytes ?? 0), 0),
              )}; shared layers may reduce the space freed. You can download these models again.`
            : ""
        }
        confirmLabel="Remove"
        onConfirm={() => {
          // Removing weights changes the store on disk, so every figure drawn
          // from the scan (dedupe, locations, orphans) is stale the moment it
          // lands — rescan rather than leaving the user to press the button.
          const removals = (pendingRemove ?? []).map((m) => removeModel(m.id));
          void Promise.all(removals).then(() => rescan());
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
