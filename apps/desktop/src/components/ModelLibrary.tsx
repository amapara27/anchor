import { useMemo, useState } from "react";
import type { LibraryModel, SortKey, StatusFilter } from "../types";
import { useModels } from "../lib/useModels";
import { useFavorites } from "../lib/useFavorites";
import { useHardwareProfile } from "../lib/useHardwareProfile";
import { catalogFamilies } from "../lib/catalog";
import { LibraryToolbar } from "./LibraryToolbar";
import { ModelCard } from "./ModelCard";
import { ModelDetailDrawer } from "./ModelDetailDrawer";
import { RefreshIcon, SearchIcon, WarningIcon } from "./icons";

function matchesQuery(m: LibraryModel, q: string): boolean {
  const hay = [m.name, m.family, m.spec.publisher, ...m.spec.use_cases, ...m.tags]
    .join(" ")
    .toLowerCase();
  return hay.includes(q);
}

const SORTERS: Record<SortKey, (a: LibraryModel, b: LibraryModel) => number> = {
  name: (a, b) => a.name.localeCompare(b.name),
  params: (a, b) => b.spec.params_b - a.spec.params_b,
  size: (a, b) => (b.size_bytes ?? 0) - (a.size_bytes ?? 0),
};

export function ModelLibrary() {
  const { models, loading, error, downloads, reload, startDownload, cancelDownload, removeModel, setTags, setNote } =
    useModels();
  const { isFavorite, toggleFavorite } = useFavorites();
  const { profile } = useHardwareProfile();
  const totalMemoryBytes = profile?.memory_bytes ?? null;

  const [query, setQuery] = useState("");
  const [status, setStatus] = useState<StatusFilter>("all");
  const [family, setFamily] = useState("all");
  const [sort, setSort] = useState<SortKey>("name");
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const families = useMemo(() => catalogFamilies(), []);
  const q = query.trim().toLowerCase();

  // Filter on everything except status first, so the status tabs can show counts.
  const preStatus = useMemo(
    () => models.filter((m) => (family === "all" || m.family === family) && (q === "" || matchesQuery(m, q))),
    [models, family, q],
  );

  const counts = useMemo<Record<StatusFilter, number>>(
    () => ({
      all: preStatus.length,
      installed: preStatus.filter((m) => m.status === "installed").length,
      available: preStatus.filter((m) => m.status === "available").length,
    }),
    [preStatus],
  );

  const visible = useMemo(
    () =>
      preStatus
        .filter((m) => status === "all" || m.status === status)
        .sort(SORTERS[sort]),
    [preStatus, status, sort],
  );

  const selected = useMemo(() => models.find((m) => m.id === selectedId) ?? null, [models, selectedId]);

  return (
    <div className="space-y-5">
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold tracking-tight text-slate-50">Model Library</h1>
        <p className="text-sm text-slate-400">
          Browse, download, and manage your local models — without the terminal.
        </p>
      </header>

      <LibraryToolbar
        query={query}
        onQuery={setQuery}
        status={status}
        onStatus={setStatus}
        family={family}
        onFamily={setFamily}
        families={families}
        sort={sort}
        onSort={setSort}
        counts={counts}
      />

      {!loading && error && <ErrorBanner message={error} onRetry={reload} />}

      {loading && <SkeletonGrid />}

      {!loading && visible.length === 0 && <EmptyState hasModels={models.length > 0} />}

      {!loading && visible.length > 0 && (
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
          {visible.map((m) => (
            <ModelCard
              key={m.id}
              model={m}
              download={downloads[m.id]}
              selected={m.id === selectedId}
              onSelect={() => setSelectedId(m.id)}
              onDownload={() => startDownload(m)}
              onCancel={() => cancelDownload(m.id)}
              favorite={isFavorite(m.id)}
              onToggleFavorite={() => toggleFavorite(m.id)}
              totalMemoryBytes={totalMemoryBytes}
            />
          ))}
        </div>
      )}

      <ModelDetailDrawer
        model={selected}
        download={selected ? downloads[selected.id] : undefined}
        onClose={() => setSelectedId(null)}
        onDownload={() => selected && startDownload(selected)}
        onCancel={() => selected && cancelDownload(selected.id)}
        onRemove={() => selected && removeModel(selected.id)}
        onTagsChange={(tags) => selected && setTags(selected.id, tags)}
        onNoteChange={(note) => selected && setNote(selected.id, note)}
        totalMemoryBytes={totalMemoryBytes}
      />
    </div>
  );
}

function SkeletonGrid() {
  return (
    <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3" aria-hidden>
      {Array.from({ length: 6 }).map((_, i) => (
        <div key={i} className="animate-pulse rounded-xl border border-slate-800 bg-slate-900/50 p-4">
          <div className="flex items-center justify-between">
            <div className="h-4 w-32 rounded bg-slate-800" />
            <div className="h-5 w-20 rounded-full bg-slate-800" />
          </div>
          <div className="mt-3 h-3 w-full rounded bg-slate-800" />
          <div className="mt-2 h-3 w-2/3 rounded bg-slate-800" />
          <div className="mt-4 flex gap-1.5">
            <div className="h-6 w-14 rounded-md bg-slate-800" />
            <div className="h-6 w-16 rounded-md bg-slate-800" />
            <div className="h-6 w-12 rounded-md bg-slate-800" />
          </div>
        </div>
      ))}
    </div>
  );
}

function EmptyState({ hasModels }: { hasModels: boolean }) {
  return (
    <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-slate-800 px-6 py-16 text-center">
      <SearchIcon className="size-6 text-slate-600" />
      <p className="mt-3 text-slate-300">No models match your filters</p>
      <p className="mt-1 max-w-xs text-sm text-slate-500">
        {hasModels
          ? "Try a different search term, family, or status filter."
          : "The registry is empty — download a model to get started."}
      </p>
    </div>
  );
}

/**
 * Non-blocking notice shown when the backend couldn't be reached. The catalog
 * of available models still renders beneath it; only on-disk install state is
 * unconfirmed, so this is a banner rather than a full-screen error.
 */
function ErrorBanner({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div
      role="status"
      className="flex items-start gap-3 rounded-xl border border-amber-900/40 bg-amber-950/20 px-4 py-3"
    >
      <WarningIcon className="mt-0.5 size-4 shrink-0 text-amber-400" />
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium text-amber-200">Couldn’t confirm installed models</p>
        <p className="mt-0.5 truncate text-xs text-amber-300/70" title={message}>
          Showing the catalog; install state may be out of date. ({message})
        </p>
      </div>
      <button
        type="button"
        onClick={onRetry}
        className="inline-flex shrink-0 cursor-pointer items-center gap-1.5 rounded-lg border border-amber-800/50 px-2.5 py-1 text-xs font-medium text-amber-200 transition-colors hover:bg-amber-900/30 focus:outline-none focus-visible:ring-2 focus-visible:ring-amber-500/40"
      >
        <RefreshIcon className="size-3.5" /> Retry
      </button>
    </div>
  );
}
