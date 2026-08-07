import { useMemo, useState } from "react";
import type { LibraryModel } from "../types";
import { useModels } from "../lib/useModels";
import { formatBytes } from "../lib/format";
import { getLastUsed, isStale, STALE_DAYS } from "../lib/lastUsed";
import { PageHeader, GhostButton } from "./PageHeader";
import { StatCard } from "./ui/StatCard";
import { SegmentedBar, type Segment } from "./ui/SegmentedBar";
import { NotBuiltYet } from "./ui/NotBuiltYet";
import { ConfirmDialog } from "./ui/ConfirmDialog";
import { CheckIcon } from "./icons";

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
 * Everything shown is real (`useModels` + `lastUsed`). Dedupe savings, symlink
 * integrity, on-disk locations and housekeeping rules need a blob scanner in
 * `anchor-hub` that doesn't exist yet, so those sections say so rather than
 * showing a figure nothing computed.
 */
export function StoragePage() {
  const { models, error, removeModel } = useModels();
  const [selected, setSelected] = useState<Record<string, boolean>>({});
  const [pendingRemove, setPendingRemove] = useState<LibraryModel[] | null>(null);

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
          <GhostButton disabled title="Awaiting a blob scanner in anchor-hub">
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
        <NotBuiltYet>
          Dedupe savings and symlink integrity need a blob scanner in <code className="data">anchor-hub</code>.
          Nothing computes blob digests or shared-blob state yet, so there's no honest number to show here.
        </NotBuiltYet>
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
          <NotBuiltYet>
            Where each blob actually lives, and which are shared between the Ollama and Hugging Face caches.
            Needs the same scanner — Anchor doesn't walk the stores yet.
          </NotBuiltYet>
        </section>

        <section className="card flex flex-col gap-3 p-4">
          <span className="label-caps">Housekeeping</span>
          <NotBuiltYet>
            Auto-dedupe on pull, stale flagging, and refusing a load that would push you into swap. Removing a
            model above is the only reclaim Anchor performs today.
          </NotBuiltYet>
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
    </>
  );
}
