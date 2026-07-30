import { useMemo, useState } from "react";
import type { LibraryModel } from "../types";
import { useModelSearch } from "../lib/useModelSearch";
import { useModels } from "../lib/useModels";
import { useHardwareProfile } from "../lib/useHardwareProfile";
import { PageHeader } from "./PageHeader";
import { SearchResultCard } from "./SearchResultCard";
import { Button } from "./ui/Button";
import { Chip } from "./ui/Chip";
import { ClockIcon, RefreshIcon, SearchIcon, SparkleIcon, WarningIcon, XIcon } from "./icons";

/** First-run suggestions so the empty state is never a dead end. */
const EXAMPLES = [
  "summarize long documents",
  "write and debug Python code",
  "a knowledge base over my files",
  "describe what's in an image",
  "run on a low-memory laptop",
];

export function SearchPage() {
  const { results, confident, status, error, query, recents, search } = useModelSearch();
  const { models, downloads, startDownload, cancelDownload } = useModels();
  const { profile } = useHardwareProfile();
  const totalMemoryBytes = profile?.memory_bytes ?? null;

  const [input, setInput] = useState("");

  // Live install state by id, so result cards can reuse the library's flow.
  const byId = useMemo(() => new Map(models.map((m) => [m.id, m])), [models]);

  const run = (q: string) => {
    setInput(q);
    search(q);
  };

  const renderCard = (result: (typeof results)[number], rank: number, hero: boolean) => {
    const lib: LibraryModel | undefined = byId.get(result.profile.id);
    return (
      <SearchResultCard
        key={result.profile.id}
        result={result}
        rank={rank}
        confident={confident}
        hero={hero}
        libraryModel={lib}
        download={downloads[result.profile.id]}
        onDownload={() => lib && startDownload(lib)}
        onCancel={() => cancelDownload(result.profile.id)}
        totalMemoryBytes={totalMemoryBytes}
      />
    );
  };

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Discover"
        title="Find the right model"
        subtitle="Describe what you want to do — we'll match it to the best local models."
      />

      <form
        onSubmit={(e) => {
          e.preventDefault();
          run(input);
        }}
        className="relative max-w-2xl"
      >
        <SearchIcon className="pointer-events-none absolute left-3.5 top-1/2 size-4 -translate-y-1/2 text-fg-subtle" />
        <input
          type="text"
          inputMode="search"
          autoFocus
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder="e.g. a model for web scraping, or RAG over my notes…"
          aria-label="Describe your use case"
          className="w-full rounded-[var(--radius-card)] border border-hair bg-inset py-3 pl-10 pr-32 text-sm text-fg placeholder:text-fg-subtle transition-colors focus:border-accent/60 focus:outline-none focus:ring-2 focus:ring-accent/25"
        />
        {/* Right cluster: clear + Search grouped so they can't overlap. */}
        <div className="absolute right-2 top-1/2 flex -translate-y-1/2 items-center gap-1">
          {input && (
            <button
              type="button"
              onClick={() => setInput("")}
              aria-label="Clear"
              className="cursor-pointer rounded p-1 text-fg-subtle transition-colors hover:text-fg focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/45"
            >
              <XIcon className="size-3.5" />
            </button>
          )}
          <Button
            variant="primary"
            type="submit"
            disabled={!input.trim() || status === "searching"}
            className="text-xs font-semibold"
          >
            <SparkleIcon className="size-3.5" /> Search
          </Button>
        </div>
      </form>

      {/* Idle: recent queries (if any) + example suggestions. */}
      {status === "idle" && (
        <div className="space-y-5">
          {recents.length > 0 && (
            <ChipRow icon={<ClockIcon className="size-3.5" />} label="Recent" chips={recents} onPick={run} />
          )}
          <ChipRow icon={<SparkleIcon className="size-3.5" />} label="Try" chips={EXAMPLES} onPick={run} />
        </div>
      )}

      {status === "searching" && <ResultSkeleton />}

      {status === "error" && (
        <ErrorState message={error ?? "Something went wrong."} onRetry={() => query && search(query)} />
      )}

      {status === "ready" && (
        <div className="space-y-5">
          {/* Results header: query up front, count as a mono figure. */}
          <div className="flex flex-wrap items-end justify-between gap-2">
            <div className="min-w-0">
              <span className="label-caps">Query results</span>
              <h2 className="mt-1 truncate text-2xl font-semibold tracking-tight text-fg">“{query}”</h2>
              {!confident && (
                <p className="mt-1 text-sm text-fg-muted">No strong match — showing related models.</p>
              )}
            </div>
            <span className="mono-metric shrink-0 text-xs text-fg-muted">
              Found: {results.length} {results.length === 1 ? "model" : "models"}
            </span>
          </div>

          {/* Top match leads full-width; the rest sit in a two-up grid below. */}
          {confident && results.length > 0 && renderCard(results[0], 1, true)}
          {results.length > (confident ? 1 : 0) && (
            <div className="space-y-3">
              {confident && <h3 className="label-caps">Other relevant models</h3>}
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                {results.slice(confident ? 1 : 0).map((r, i) => renderCard(r, (confident ? 2 : 1) + i, false))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

/** A labelled row of clickable query chips (recents / examples). */
function ChipRow({
  icon,
  label,
  chips,
  onPick,
}: {
  icon: React.ReactNode;
  label: string;
  chips: string[];
  onPick: (q: string) => void;
}) {
  return (
    <div className="flex flex-wrap items-center gap-2">
      <span className="inline-flex items-center gap-1.5 text-xs font-medium text-fg-subtle">
        {icon}
        {label}
      </span>
      {chips.map((chip) => (
        <button
          key={chip}
          type="button"
          onClick={() => onPick(chip)}
          className="cursor-pointer rounded-md transition-colors duration-150 ease-out focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/45"
        >
          <Chip className="hover:text-fg hover:ring-hair2">{chip}</Chip>
        </button>
      ))}
    </div>
  );
}

function ResultSkeleton() {
  return (
    <div className="space-y-3" aria-hidden>
      {Array.from({ length: 3 }).map((_, i) => (
        <div key={i} className="card shimmer p-4">
          <div className="flex items-center justify-between">
            <div className="h-4 w-40 rounded bg-raised" />
            <div className="h-7 w-24 rounded-lg bg-raised" />
          </div>
          <div className="mt-3 h-1.5 w-full rounded-full bg-raised" />
          <div className="mt-3 h-3 w-full rounded bg-raised" />
          <div className="mt-2 h-3 w-3/4 rounded bg-raised" />
        </div>
      ))}
    </div>
  );
}

function ErrorState({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="flex items-start gap-3 rounded-[var(--radius-card)] border border-hair bg-inset px-4 py-3" role="status">
      <WarningIcon className="mt-0.5 size-4 shrink-0 text-warn" />
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium text-fg">Couldn’t run the search</p>
        <p className="mt-0.5 text-xs text-fg-muted">{message}</p>
      </div>
      <button
        type="button"
        onClick={onRetry}
        className="inline-flex shrink-0 cursor-pointer items-center gap-1.5 rounded-lg border border-hair px-2.5 py-1 text-xs font-medium text-fg-muted transition-colors hover:border-hair2 hover:text-fg focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/45"
      >
        <RefreshIcon className="size-3.5" /> Retry
      </button>
    </div>
  );
}
