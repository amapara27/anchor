import { useEffect, useMemo, useState } from "react";
import type { LibraryModel, SortKey, StatusFilter } from "../types";
import { useModels } from "../lib/useModels";
import { useFavorites } from "../lib/useFavorites";
import { useHardwareProfile } from "../lib/useHardwareProfile";
import { LibraryToolbar, type LibraryView } from "./LibraryToolbar";
import { ModelCard } from "./ModelCard";
import { ModelTable } from "./ModelTable";
import { ModelDetailDrawer } from "./ModelDetailDrawer";
import { PageHeader } from "./PageHeader";
import { RefreshIcon, SearchIcon, WarningIcon } from "./icons";

const VIEW_KEY = "anchor.libraryView";

interface ModelLibraryProps {
  /** Open a model's detail drawer from outside (e.g. the command palette). The
   *  nonce lets the same id be re-opened after the drawer is closed. */
  openModel?: { id: string; nonce: number } | null;
}

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

export function ModelLibrary({ openModel }: ModelLibraryProps = {}) {
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
  const [view, setView] = useState<LibraryView>(() => {
    try {
      return localStorage.getItem(VIEW_KEY) === "cards" ? "cards" : "table";
    } catch {
      return "table";
    }
  });

  useEffect(() => {
    try {
      localStorage.setItem(VIEW_KEY, view);
    } catch {
      // storage unavailable — view stays in-memory
    }
  }, [view]);

  // Open a model's drawer when the palette requests it (nonce forces re-open).
  useEffect(() => {
    if (openModel?.id) setSelectedId(openModel.id);
  }, [openModel]);

  // Families come from the loaded library (backend catalog + installed extras),
  // so the filter always reflects what's actually shown.
  const families = useMemo(
    () => [...new Set(models.map((m) => m.family))].sort(),
    [models],
  );
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
      <PageHeader
        eyebrow="Catalog"
        title="Model Library"
        subtitle="Browse, download, and manage your local models — without the terminal."
      />

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
        view={view}
        onView={setView}
      />

      {!loading && error && <ErrorBanner message={error} onRetry={reload} />}

      {loading && <SkeletonGrid />}

      {!loading && visible.length === 0 && <EmptyState hasModels={models.length > 0} />}

      {!loading && visible.length > 0 && view === "table" && (
        <ModelTable
          models={visible}
          downloads={downloads}
          selectedId={selectedId}
          onSelect={setSelectedId}
          onDownload={startDownload}
          onCancel={cancelDownload}
          chip={profile?.chip ?? null}
          totalMemoryBytes={totalMemoryBytes}
        />
      )}

      {!loading && visible.length > 0 && view === "cards" && (
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
        <div key={i} className="card shimmer p-4">
          <div className="flex items-center justify-between">
            <div className="h-4 w-32 rounded bg-white/8" />
            <div className="h-5 w-20 rounded-full bg-white/8" />
          </div>
          <div className="mt-3 h-3 w-full rounded bg-white/8" />
          <div className="mt-2 h-3 w-2/3 rounded bg-white/8" />
          <div className="mt-4 flex gap-1.5">
            <div className="h-6 w-14 rounded-md bg-white/5" />
            <div className="h-6 w-16 rounded-md bg-white/5" />
            <div className="h-6 w-12 rounded-md bg-white/5" />
          </div>
        </div>
      ))}
    </div>
  );
}

function EmptyState({ hasModels }: { hasModels: boolean }) {
  return (
    <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-white/10 bg-white/[0.015] px-6 py-14 text-center">
      <span className="flex size-12 items-center justify-center rounded-full bg-white/5 text-fg-subtle ring-1 ring-inset ring-white/10">
        <SearchIcon className="size-5" />
      </span>
      <p className="mt-4 font-medium text-fg">No models match your filters</p>
      <p className="mt-1 max-w-xs text-sm text-fg-muted">
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
      className="flex items-start gap-3 rounded-xl border border-white/10 bg-white/[0.02] px-4 py-3"
    >
      <WarningIcon className="mt-0.5 size-4 shrink-0 text-warn" />
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium text-fg">Couldn’t confirm installed models</p>
        <p className="mt-0.5 truncate text-xs text-fg-muted" title={message}>
          Showing the catalog; install state may be out of date. ({message})
        </p>
      </div>
      <button
        type="button"
        onClick={onRetry}
        className="inline-flex shrink-0 cursor-pointer items-center gap-1.5 rounded-lg border border-white/12 px-2.5 py-1 text-xs font-medium text-fg-muted transition-colors hover:border-white/20 hover:text-fg focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/45"
      >
        <RefreshIcon className="size-3.5" /> Retry
      </button>
    </div>
  );
}
