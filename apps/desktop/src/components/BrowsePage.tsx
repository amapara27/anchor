import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { ArchMeta, LibraryEntry, LibraryModel } from "../types";
import { useLibrary } from "../lib/useLibrary";
import { useModels } from "../lib/useModels";
import { useHardwareProfile } from "../lib/useHardwareProfile";
import { useTagArch } from "../lib/useTagArch";
import { hardwareHint, type HardwareHint } from "../lib/hint";
import { DEFAULT_CONTEXT } from "../lib/fit";
import { parseContext, parseSize, parseTagParams } from "../lib/format";
import { PageHeader, GhostButton } from "./PageHeader";
import { ProgressTrack } from "./DownloadProgressBar";
import { CheckIcon, ChevronDownIcon, DownloadIcon, RefreshIcon, SearchIcon, WarningIcon, XIcon } from "./icons";

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
export function BrowsePage({
  onSelect,
  selectedTag,
}: {
  /** Opens a clicked tag row in the shared detail aside. */
  onSelect: (m: LibraryModel) => void;
  selectedTag: string | null;
}) {
  const { entries, status, error, tags, loadingTags, reload, loadTags } = useLibrary();
  const { models, downloads, startDownload } = useModels();
  const { profile } = useHardwareProfile();
  const { arch: resolvedArch, resolving, resolve } = useTagArch();

  const [query, setQuery] = useState("");
  const [sort, setSort] = useState<Sort>("popular");
  const [caps, setCaps] = useState<string[]>([]);
  const [openEntry, setOpenEntry] = useState<LibraryEntry | null>(null);
  const [shown, setShown] = useState(PAGE);

  // Installed ids, so a row can say "installed" instead of offering a re-pull.
  const installed = useMemo(
    () => new Set(models.filter((m) => m.status === "installed").map((m) => m.id)),
    [models],
  );

  // GGUF metadata Anchor already holds, keyed by the tag the listing shows.
  // Covers the curated catalog (shipped by tools/generate-arch.mjs) and anything
  // installed; every other tag falls back to a labelled estimate.
  const archByTag = useMemo(
    () => new Map(models.filter((m) => m.arch).map((m) => [m.id, m.arch!])),
    [models],
  );
  // A tag the user explicitly resolved wins, then whatever Anchor already had.
  const archFor = useCallback(
    (tag: string) => resolvedArch[tag] ?? archByTag.get(tag) ?? null,
    [resolvedArch, archByTag],
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

  const openRow = (entry: LibraryEntry) => {
    setOpenEntry(entry);
    loadTags(entry.name);
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
              <BrowseRow key={entry.name} entry={entry} onOpen={() => openRow(entry)} />
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

      <TagPickerDialog
        entry={openEntry}
        tags={openEntry ? tags[openEntry.name] : undefined}
        loadingTags={!!(openEntry && loadingTags[openEntry.name])}
        installed={installed}
        downloads={downloads}
        onPull={startDownload}
        archFor={archFor}
        hardware={profile}
        onResolve={resolve}
        resolving={resolving}
        onSelect={(m) => {
          onSelect(m);
          setOpenEntry(null);
        }}
        selectedTag={selectedTag}
        onClose={() => setOpenEntry(null)}
      />
    </div>
  );
}

/**
 * Whether one published tag fits this Mac.
 *
 * The listing gives size and context as display strings and no parameter count
 * at all, so everything here is parsed back out of what the page shows. Judged
 * at Ollama's default context, like every other fit surface — the question on
 * this screen is "can I run this at all", not "at what window".
 *
 * `arch` is present only for tags Anchor already has GGUF metadata for: the
 * curated catalog and anything installed. Everything else gets the labelled
 * parameter-count estimate, where weights dominate the answer anyway — a 70B is
 * out of reach on 16 GB whatever its KV cache does.
 */
function tagFit(
  t: { tag: string; size: string; context: string },
  arch: ArchMeta | null,
  hardware: { memory_bytes?: number | null } | null,
): HardwareHint | null {
  const params_b = parseTagParams(t.tag);
  const sizeBytes = parseSize(t.size);
  // Without a parameter count there is no fallback term at all, and without a
  // size there is no weights term — either way, say nothing rather than guess.
  if (!params_b || !sizeBytes) return null;
  return hardwareHint(
    {
      id: t.tag,
      params_b,
      quant: "Q4_K_M",
      contextTokens: parseContext(t.context) ?? DEFAULT_CONTEXT,
      arch,
      sizeBytes,
    },
    hardware,
  );
}

/**
 * A synthetic LibraryModel for a browsable tag, so the shared detail aside can
 * render it exactly like an installed/catalog row. Browse tags aren't catalog
 * entries — there's nothing to look up by id in `useModels()`'s list — so this
 * builds the same shape `tagFit` above already derives its verdict from.
 */
function tagToLibraryModel(
  entry: LibraryEntry,
  t: { tag: string; size: string; context: string },
  arch: ArchMeta | null,
  installed: boolean,
): LibraryModel {
  const params_b = parseTagParams(t.tag) ?? 0;
  const sizeBytes = parseSize(t.size);
  const contextTokens = parseContext(t.context) ?? DEFAULT_CONTEXT;
  return {
    id: t.tag,
    name: t.tag,
    family: entry.name,
    size_bytes: installed ? sizeBytes : null,
    status: installed ? "installed" : "available",
    parameter_size: null,
    quantization: "Q4_K_M",
    context_tokens: contextTokens,
    modified_at: null,
    publisher: null,
    arch,
    spec: {
      params_b,
      quant: "Q4_K_M",
      context_tokens: contextTokens,
      download_bytes: sizeBytes ?? 0,
      blurb: entry.description,
      use_cases: [],
      publisher: "",
      capabilities: [],
    },
    tags: [],
    note: "",
  };
}

/**
 * The fit verdict for a tag row, sharing its cell with the modality label.
 *
 * Three states, and the middle one is the point of this control:
 * - **exact** — Anchor has the model's GGUF metadata (catalog, installed, or
 *   already resolved), so the verdict is computed from its real architecture.
 * - **estimated** — marked `~` and clickable. The parameter-count bucket behind
 *   it can be several-fold wrong on an architecture Anchor has never read, so it
 *   offers to go and read one rather than quietly presenting a guess.
 * - **unknown** — the listing didn't publish enough to say anything; shows the
 *   modality alone rather than an empty cell.
 */
function TagFit({
  fit,
  modality,
  onResolve,
  resolving,
}: {
  fit: HardwareHint | null;
  modality: string;
  onResolve: () => void;
  resolving: boolean;
}) {
  if (!fit || fit.tier === "unknown") {
    return <span className="truncate text-[11px] text-fg-subtle">{modality}</span>;
  }
  const dot =
    fit.tier === "ok" ? (
      <span className="size-1.5 shrink-0 rounded-full bg-ok" aria-hidden />
    ) : (
      <WarningIcon className={`size-3 shrink-0 ${fit.tone}`} />
    );

  if (fit.fit.kvSource !== "estimated") {
    return (
      <span
        className="flex min-w-0 items-center gap-1.5 text-[11px]"
        title={`Computed from this model's architecture — ${modality}`}
      >
        {dot}
        <span className={`truncate font-medium ${fit.tone}`}>{fit.label}</span>
      </span>
    );
  }

  return (
    <button
      type="button"
      onClick={(e) => {
        e.stopPropagation();
        onResolve();
      }}
      disabled={resolving}
      title={
        resolving
          ? "Reading the model's header…"
          : `Estimated from parameter count. Click to read this model's real architecture (~1 MB, not the weights) — ${modality}`
      }
      className="flex min-w-0 cursor-pointer items-center gap-1.5 text-left text-[11px] transition-opacity duration-150 ease-out hover:opacity-80 disabled:cursor-default focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/45"
    >
      {dot}
      <span className={`truncate font-medium ${fit.tone}`}>
        {resolving ? "…" : `~${fit.label}`}
      </span>
      {!resolving && (
        <span className="shrink-0 text-[10px] text-fg-subtle underline decoration-dotted underline-offset-2">
          check
        </span>
      )}
    </button>
  );
}

/** One library model summary row — opens the tag picker dialog on click. */
function BrowseRow({ entry, onOpen }: { entry: LibraryEntry; onOpen: () => void }) {
  return (
    <button
      type="button"
      onClick={onOpen}
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
        <ChevronDownIcon className="size-3.5 -rotate-90 text-fg-subtle" />
      </span>
    </button>
  );
}

/** One tag row — identical markup whether it's the only consumer left, the tag picker dialog. */
function TagRow({
  entry,
  t,
  installed,
  downloads,
  onPull,
  archFor,
  hardware,
  onResolve,
  resolving,
  onSelect,
  selectedTag,
}: {
  entry: LibraryEntry;
  t: { tag: string; size: string; context: string; modality: string; digest: string };
  installed: Set<string>;
  downloads: ReturnType<typeof useModels>["downloads"];
  onPull: (id: string) => void;
  archFor: (tag: string) => ArchMeta | null;
  hardware: { memory_bytes?: number | null; chip?: string | null } | null;
  onResolve: (tag: string, digest: string) => void;
  resolving: Record<string, boolean>;
  onSelect: (m: LibraryModel) => void;
  selectedTag: string | null;
}) {
  const download = downloads[t.tag];
  const have = installed.has(t.tag);
  const fit = tagFit(t, archFor(t.tag), hardware);
  return (
    <div
      onClick={() => onSelect(tagToLibraryModel(entry, t, archFor(t.tag), have))}
      className={[
        "grid cursor-pointer grid-cols-[minmax(0,1fr)_72px_56px_minmax(0,132px)_104px] items-center gap-3 border-b border-hair px-4 py-2 last:border-b-0",
        "transition-colors duration-150 ease-out hover:bg-raised",
        t.tag === selectedTag ? "bg-inset" : "",
      ].join(" ")}
    >
      <span className="data min-w-0 truncate text-[12px] text-fg" title={t.tag}>
        {t.tag}
      </span>
      <span className="data text-right text-[11px] text-fg-muted">{t.size}</span>
      <span className="data text-right text-[11px] text-fg-muted">{t.context}</span>
      <TagFit
        fit={fit}
        modality={t.modality}
        onResolve={() => onResolve(t.tag, t.digest)}
        resolving={!!resolving[t.tag]}
      />
      {have ? (
        <span className="flex items-center justify-end gap-1.5 text-[11px] text-ok">
          <CheckIcon className="size-3" /> installed
        </span>
      ) : download ? (
        // The listing gives size as a string ("4.9GB"), so there's no byte
        // total to count against — show the percentage only.
        <span className="flex flex-col items-end gap-1">
          <span className="data text-[10.5px] text-fg-subtle">
            {download.status === "verifying" ? "verifying…" : `${Math.round(download.progress * 100)}%`}
          </span>
          <ProgressTrack
            pct={download.status === "verifying" ? 100 : download.progress * 100}
            className="h-1 w-full"
          />
        </span>
      ) : (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation();
            onPull(t.tag);
          }}
          className="flex cursor-pointer items-center justify-center gap-1.5 rounded-lg border border-hair px-2 py-1 text-[11px] text-fg-muted transition-colors hover:border-hair2 hover:text-fg focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/45"
        >
          <DownloadIcon className="size-3" /> Pull
        </button>
      )}
    </div>
  );
}

/**
 * Picks one tag from a library model's full tag list, in a bounded, scrollable,
 * filterable overlay instead of an inline accordion — some families (llama3.1,
 * qwen2.5, …) publish 90+ tags, which used to push a page-length block into the
 * row list itself. Chrome mirrors `ConfirmDialog` (backdrop, Escape-to-close,
 * focus-on-open); the scrollable filtered list mirrors `CommandPalette`.
 */
function TagPickerDialog({
  entry,
  tags,
  loadingTags,
  installed,
  downloads,
  onPull,
  archFor,
  hardware,
  onResolve,
  resolving,
  onSelect,
  selectedTag,
  onClose,
}: {
  entry: LibraryEntry | null;
  tags: ReturnType<typeof useLibrary>["tags"][string] | undefined;
  loadingTags: boolean;
  installed: Set<string>;
  downloads: ReturnType<typeof useModels>["downloads"];
  onPull: (id: string) => void;
  archFor: (tag: string) => ArchMeta | null;
  hardware: { memory_bytes?: number | null; chip?: string | null } | null;
  onResolve: (tag: string, digest: string) => void;
  resolving: Record<string, boolean>;
  onSelect: (m: LibraryModel) => void;
  selectedTag: string | null;
  onClose: () => void;
}) {
  const [filter, setFilter] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!entry) return;
    setFilter("");
    requestAnimationFrame(() => inputRef.current?.focus());
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [entry, onClose]);

  if (!entry) return null;

  const q = filter.trim().toLowerCase();
  const filtered = q ? tags?.filter((t) => t.tag.toLowerCase().includes(q)) : tags;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center px-4" role="dialog" aria-modal="true" aria-label={`${entry.name} tags`}>
      <div className="absolute inset-0 bg-black/60" onClick={onClose} aria-hidden />
      <div
        ref={panelRef}
        tabIndex={-1}
        className="relative flex max-h-[80vh] w-full max-w-2xl flex-col overflow-hidden rounded-[var(--radius-card)] border border-hair2 bg-surface shadow-(--shadow-overlay) outline-none"
      >
        <div className="flex items-start justify-between gap-3 border-b border-hair px-5 py-4">
          <div className="min-w-0">
            <h2 className="data text-[14px] font-semibold text-fg">{entry.name}</h2>
            <p className="mt-0.5 line-clamp-2 text-[11.5px] leading-relaxed text-fg-muted">
              {entry.description}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            aria-label="Close"
            className="flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-md text-fg-subtle transition-colors hover:bg-inset hover:text-fg focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/45"
          >
            <XIcon className="size-4" />
          </button>
        </div>

        <label className="flex h-9 shrink-0 items-center gap-2 border-b border-hair px-5">
          <SearchIcon className="size-3.5 shrink-0 text-fg-subtle" />
          <input
            ref={inputRef}
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            placeholder={`Filter ${entry.tag_count} tags…`}
            aria-label="Filter tags"
            className="min-w-0 flex-1 bg-transparent text-[12.5px] text-fg placeholder:text-fg-subtle focus:outline-none"
          />
        </label>

        <div className="scrollbar-slim min-h-0 flex-1 overflow-y-auto">
          {loadingTags && !tags && <p className="px-5 py-6 text-center text-[11.5px] text-fg-subtle">Loading tags…</p>}
          {!loadingTags && !tags && (
            <p className="px-5 py-6 text-center text-[11.5px] text-fg-subtle">
              Couldn’t load tags — close and reopen to retry.
            </p>
          )}
          {tags?.length === 0 && (
            <p className="px-5 py-6 text-center text-[11.5px] text-fg-subtle">No tags published.</p>
          )}
          {filtered?.length === 0 && tags && tags.length > 0 && (
            <p className="px-5 py-6 text-center text-[11.5px] text-fg-subtle">No tags match “{filter}”.</p>
          )}
          {filtered?.map((t) => (
            <TagRow
              key={t.tag}
              entry={entry}
              t={t}
              installed={installed}
              downloads={downloads}
              onPull={onPull}
              archFor={archFor}
              hardware={hardware}
              onResolve={onResolve}
              resolving={resolving}
              onSelect={onSelect}
              selectedTag={selectedTag}
            />
          ))}
        </div>
      </div>
    </div>
  );
}
