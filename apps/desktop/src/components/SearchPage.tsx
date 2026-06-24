import { useMemo, useState } from "react";
import type { LibraryModel } from "../types";
import { useModelSearch } from "../lib/useModelSearch";
import { useModels } from "../lib/useModels";
import { useHardwareProfile } from "../lib/useHardwareProfile";
import { PageHeader } from "./PageHeader";
import { SearchResultCard } from "./SearchResultCard";
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
  const { results, status, error, query, recents, search } = useModelSearch();
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

  const topScore = results[0]?.score ?? 1;

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
          className="w-full rounded-xl border border-white/8 bg-white/5 py-3 pl-10 pr-32 text-sm text-fg placeholder:text-fg-subtle transition-colors focus:border-accent/60 focus:outline-none focus:ring-2 focus:ring-accent/25"
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
          <button
            type="submit"
            disabled={!input.trim() || status === "searching"}
            className="inline-flex cursor-pointer items-center gap-1.5 rounded-lg bg-accent px-3 py-1.5 text-xs font-semibold text-accent-fg transition-colors hover:bg-accent/90 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/50 active:scale-[0.97] disabled:cursor-not-allowed disabled:opacity-40"
          >
            <SparkleIcon className="size-3.5" /> Search
          </button>
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
        <div className="space-y-3">
          <h2 className="text-sm font-medium text-fg-muted">
            Top {results.length} for <span className="text-fg">“{query}”</span>
          </h2>
          {results.map((result, i) => {
            const lib: LibraryModel | undefined = byId.get(result.profile.id);
            return (
              <SearchResultCard
                key={result.profile.id}
                result={result}
                rank={i + 1}
                relative={topScore > 0 ? result.score / topScore : 0}
                libraryModel={lib}
                download={downloads[result.profile.id]}
                onDownload={() => lib && startDownload(lib)}
                onCancel={() => cancelDownload(result.profile.id)}
                totalMemoryBytes={totalMemoryBytes}
              />
            );
          })}
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
          className="cursor-pointer rounded-lg border border-white/8 bg-white/5 px-2.5 py-1 text-xs font-medium text-fg-muted transition-colors hover:border-white/15 hover:text-fg focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/45"
        >
          {chip}
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
            <div className="h-4 w-40 rounded bg-white/8" />
            <div className="h-7 w-24 rounded-lg bg-white/8" />
          </div>
          <div className="mt-3 h-1.5 w-full rounded-full bg-white/8" />
          <div className="mt-3 h-3 w-full rounded bg-white/8" />
          <div className="mt-2 h-3 w-3/4 rounded bg-white/8" />
        </div>
      ))}
    </div>
  );
}

function ErrorState({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="flex items-start gap-3 rounded-xl border border-white/10 bg-white/[0.02] px-4 py-3" role="status">
      <WarningIcon className="mt-0.5 size-4 shrink-0 text-warn" />
      <div className="min-w-0 flex-1">
        <p className="text-sm font-medium text-fg">Couldn’t run the search</p>
        <p className="mt-0.5 text-xs text-fg-muted">{message}</p>
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
