import { useMemo, useState } from "react";
import type { LibraryEntry } from "../types";
import { useLibrary } from "../lib/useLibrary";
import { useModels } from "../lib/useModels";
import { PageHeader, GhostButton } from "./PageHeader";
import { ProgressTrack } from "./DownloadProgressBar";
import { CheckIcon, ChevronDownIcon, DownloadIcon, RefreshIcon, SearchIcon, WarningIcon } from "./icons";

/** Sorts offered over the listing. */
const SORTS = [
  { key: "popular", label: "Most pulled" },
  { key: "recent", label: "Recently updated" },
  { key: "name", label: "Name" },
] as const;
type Sort = (typeof SORTS)[number]["key"];

/** The capability badges worth filtering on — the ones the library actually emits. */
const CAPABILITIES = ["tools", "vision", "thinking", "embedding"];

/** Rows rendered before "show more" — 231 models is a lot of DOM to build eagerly. */
const PAGE = 40;

const UNITS: Record<string, number> = {
  hour: 3_600_000,
  day: 86_400_000,
  week: 604_800_000,
  month: 2_629_800_000,
  year: 31_557_600_000,
};

/**
 * Approximate age in ms from the site's relative wording ("3 days ago").
 *
 * ponytail: the listing publishes no timestamp, only this phrasing, so sorting
 * by recency means parsing it. Approximate is fine — this only ever decides an
 * ordering, never a displayed date. Unrecognised wording sorts oldest.
 */
function ageMs(updated: string): number {
  const m = updated.match(/(\d+)\s+(hour|day|week|month|year)/);
  if (!m) return Number.MAX_SAFE_INTEGER;
  return Number(m[1]) * (UNITS[m[2]] ?? 0);
}

/** Compact pull count: 118100000 → "118.1M". */
function formatPulls(n: number): string {
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return String(n);
}

/**
 * Browse every model on ollama.com, not just the curated ones Discover ranks.
 *
 * Discover answers "what should I use for X?" against 38 authored profiles;
 * this answers "what exists?" against the whole library. Rows expand to their
 * real tag list — the quantisation variants are where the actual download
 * choice lives, and they're not in any catalog.
 */
export function BrowsePage() {
  const { entries, status, error, tags, loadingTags, reload, loadTags } = useLibrary();
  const { models, downloads, startDownload } = useModels();

  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<Sort>("popular");
  const [caps, setCaps] = useState<string[]>([]);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [shown, setShown] = useState(PAGE);

  // Installed ids, so a row can say "installed" instead of offering a re-pull.
  const installed = useMemo(
    () => new Set(models.filter((m) => m.status === "installed").map((m) => m.id)),
    [models],
  );

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    const filtered = entries.filter((e) => {
      if (q && !`${e.name} ${e.description}`.toLowerCase().includes(q)) return false;
      return caps.every((c) => e.capabilities.includes(c));
    });
    const sorted = [...filtered];
    if (sort === "popular") sorted.sort((a, b) => b.pulls - a.pulls);
    if (sort === "recent") sorted.sort((a, b) => ageMs(a.updated) - ageMs(b.updated));
    if (sort === "name") sorted.sort((a, b) => a.name.localeCompare(b.name));
    return sorted;
  }, [entries, query, caps, sort]);

  const toggleCap = (c: string) => {
    setShown(PAGE);
    setCaps((list) => (list.includes(c) ? list.filter((x) => x !== c) : [...list, c]));
  };

  const toggleRow = (name: string) => {
    const next = expanded === name ? null : name;
    setExpanded(next);
    if (next) loadTags(next);
  };

  return (
    <div className="space-y-5">
      <PageHeader
        eyebrow="Discover"
        title="The whole Ollama library"
        subtitle="Every model published on ollama.com. Expand one to pick an exact tag."
        actions={
          <GhostButton onClick={() => reload(true)} title="Re-read the listing from ollama.com">
            <RefreshIcon className={`size-3.5 ${status === "loading" ? "animate-spin" : ""}`} />
            Refresh
          </GhostButton>
        }
      />

      <div className="flex flex-wrap items-center gap-2.5">
        <label className="flex h-8 w-[260px] items-center gap-2 rounded-lg border border-hair bg-surface px-2.5">
          <SearchIcon className="size-3.5 shrink-0 text-fg-subtle" />
          <input
            value={query}
            onChange={(e) => {
              setQuery(e.target.value);
              setShown(PAGE);
            }}
            placeholder="Filter by name or description…"
            aria-label="Filter the library"
            className="min-w-0 flex-1 bg-transparent text-[12.5px] text-fg placeholder:text-fg-subtle focus:outline-none"
          />
        </label>

        <div className="flex flex-wrap gap-1.5">
          {CAPABILITIES.map((c) => {
            const on = caps.includes(c);
            return (
              <button
                key={c}
                type="button"
                aria-pressed={on}
                onClick={() => toggleCap(c)}
                className={[
                  "flex h-7 cursor-pointer items-center rounded-full border px-3 text-xs transition-colors duration-150 ease-out",
                  "focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/45",
                  on
                    ? "border-accent-line bg-accent-soft text-accent-text"
                    : "border-hair text-fg-muted hover:border-hair2 hover:text-fg",
                ].join(" ")}
              >
                {c}
              </button>
            );
          })}
        </div>

        <div className="ml-auto flex items-center gap-1.5">
          {SORTS.map((s) => (
            <button
              key={s.key}
              type="button"
              aria-pressed={sort === s.key}
              onClick={() => setSort(s.key)}
              className={[
                "h-7 cursor-pointer rounded-lg px-2.5 text-xs transition-colors duration-150 ease-out",
                "focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/45",
                sort === s.key ? "bg-inset text-fg" : "text-fg-subtle hover:text-fg",
              ].join(" ")}
            >
              {s.label}
            </button>
          ))}
        </div>
      </div>

      {status === "error" && (
        <div className="flex items-start gap-3 rounded-[var(--radius-card)] border border-hair bg-inset px-4 py-3" role="status">
          <WarningIcon className="mt-0.5 size-4 shrink-0 text-warn" />
          <div className="min-w-0 flex-1">
            <p className="text-sm font-medium text-fg">Couldn’t read the library listing</p>
            <p className="mt-0.5 text-xs text-fg-muted">{error}</p>
          </div>
          <GhostButton className="h-7 shrink-0 text-xs" onClick={() => reload(true)}>
            Retry
          </GhostButton>
        </div>
      )}

      {status === "loading" && entries.length === 0 ? (
        <div className="card shimmer h-72" aria-hidden />
      ) : (
        <>
          <div className="flex items-baseline gap-2.5">
            <span className="label-caps">
              {visible.length} {visible.length === 1 ? "model" : "models"}
            </span>
            <span className="data ml-auto text-[11px] text-fg-subtle">from ollama.com/library</span>
          </div>

          <section className="card divide-y divide-hair overflow-hidden">
            {visible.slice(0, shown).map((entry) => (
              <BrowseRow
                key={entry.name}
                entry={entry}
                open={expanded === entry.name}
                onToggle={() => toggleRow(entry.name)}
                tags={tags[entry.name]}
                loadingTags={!!loadingTags[entry.name]}
                installed={installed}
                downloads={downloads}
                onPull={startDownload}
              />
            ))}
            {visible.length === 0 && (
              <p className="px-4 py-10 text-center text-sm text-fg-subtle">
                Nothing matches those filters.
              </p>
            )}
          </section>

          {shown < visible.length && (
            <div className="flex justify-center">
              <GhostButton onClick={() => setShown((n) => n + PAGE)}>
                Show more ({visible.length - shown} left)
              </GhostButton>
            </div>
          )}
        </>
      )}
    </div>
  );
}

/** One library model: summary line, and its tag list once expanded. */
function BrowseRow({
  entry,
  open,
  onToggle,
  tags,
  loadingTags,
  installed,
  downloads,
  onPull,
}: {
  entry: LibraryEntry;
  open: boolean;
  onToggle: () => void;
  tags: ReturnType<typeof useLibrary>["tags"][string] | undefined;
  loadingTags: boolean;
  installed: Set<string>;
  downloads: ReturnType<typeof useModels>["downloads"];
  onPull: (id: string) => void;
}) {
  return (
    <div>
      <button
        type="button"
        onClick={onToggle}
        aria-expanded={open}
        className="grid w-full grid-cols-[minmax(0,1fr)_auto] items-start gap-3 px-4 py-3 text-left transition-colors duration-150 ease-out hover:bg-inset"
      >
        <span className="flex min-w-0 flex-col gap-1">
          <span className="flex flex-wrap items-center gap-2">
            <span className="data text-[13px] font-medium text-fg">{entry.name}</span>
            {entry.capabilities.map((c) => (
              <span
                key={c}
                className="rounded-full border border-accent-line bg-accent-soft px-1.5 py-px text-[9.5px] uppercase tracking-[0.06em] text-accent-text"
              >
                {c}
              </span>
            ))}
            {entry.sizes.map((s) => (
              <span
                key={s}
                className="data rounded-full border border-hair px-1.5 py-px text-[9.5px] text-fg-subtle"
              >
                {s}
              </span>
            ))}
          </span>
          <span className="line-clamp-2 text-[11.5px] leading-[1.5] text-fg-muted">
            {entry.description}
          </span>
        </span>

        <span className="flex shrink-0 items-center gap-3">
          <span className="flex flex-col items-end gap-0.5">
            <span className="data text-[11.5px] text-fg-muted">{formatPulls(entry.pulls)} pulls</span>
            <span className="data text-[10.5px] text-fg-subtle">
              {entry.tag_count} tags · {entry.updated}
            </span>
          </span>
          <ChevronDownIcon
            className={`size-3.5 text-fg-subtle transition-transform duration-150 ease-out ${open ? "rotate-180" : ""}`}
          />
        </span>
      </button>

      {open && (
        <div className="border-t border-hair bg-inset px-4 py-2.5">
          {loadingTags && !tags && <p className="py-2 text-[11.5px] text-fg-subtle">Loading tags…</p>}
          {!loadingTags && !tags && (
            <p className="py-2 text-[11.5px] text-fg-subtle">
              Couldn’t load tags — collapse and expand to retry.
            </p>
          )}
          {tags?.length === 0 && <p className="py-2 text-[11.5px] text-fg-subtle">No tags published.</p>}
          {tags?.map((t) => {
            const download = downloads[t.tag];
            const have = installed.has(t.tag);
            return (
              <div
                key={t.tag}
                className="grid grid-cols-[minmax(0,1fr)_72px_64px_92px_104px] items-center gap-3 border-b border-hair py-2 last:border-b-0"
              >
                <span className="data min-w-0 truncate text-[12px] text-fg" title={t.tag}>
                  {t.tag}
                </span>
                <span className="data text-right text-[11px] text-fg-muted">{t.size}</span>
                <span className="data text-right text-[11px] text-fg-muted">{t.context}</span>
                <span className="truncate text-[11px] text-fg-subtle">{t.modality}</span>
                {have ? (
                  <span className="flex items-center justify-end gap-1.5 text-[11px] text-ok">
                    <CheckIcon className="size-3" /> installed
                  </span>
                ) : download ? (
                  // The listing gives size as a string ("4.9GB"), so there's no
                  // byte total to count against — show the percentage only.
                  <span className="flex flex-col items-end gap-1">
                    <span className="data text-[10.5px] text-fg-subtle">
                      {download.status === "verifying"
                        ? "verifying…"
                        : `${Math.round(download.progress * 100)}%`}
                    </span>
                    <ProgressTrack
                      pct={download.status === "verifying" ? 100 : download.progress * 100}
                      className="h-1 w-full"
                    />
                  </span>
                ) : (
                  <button
                    type="button"
                    onClick={() => onPull(t.tag)}
                    className="flex cursor-pointer items-center justify-center gap-1.5 rounded-lg border border-hair px-2 py-1 text-[11px] text-fg-muted transition-colors hover:border-hair2 hover:text-fg focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/45"
                  >
                    <DownloadIcon className="size-3" /> Pull
                  </button>
                )}
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
