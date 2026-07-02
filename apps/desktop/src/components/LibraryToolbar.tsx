import type { SortKey, StatusFilter } from "../types";
import { ChevronDownIcon, GridIcon, RowsIcon, SearchIcon, XIcon } from "./icons";

/** Library layout: the dense table is the default; cards are the alternative. */
export type LibraryView = "table" | "cards";

interface ToolbarProps {
  query: string;
  onQuery: (v: string) => void;
  status: StatusFilter;
  onStatus: (v: StatusFilter) => void;
  family: string;
  onFamily: (v: string) => void;
  families: string[];
  sort: SortKey;
  onSort: (v: SortKey) => void;
  counts: Record<StatusFilter, number>;
  view: LibraryView;
  onView: (v: LibraryView) => void;
}

const STATUS_TABS: { key: StatusFilter; label: string }[] = [
  { key: "all", label: "All" },
  { key: "installed", label: "Installed" },
  { key: "available", label: "Available" },
];

export function LibraryToolbar({
  query,
  onQuery,
  status,
  onStatus,
  family,
  onFamily,
  families,
  sort,
  onSort,
  counts,
  view,
  onView,
}: ToolbarProps) {
  return (
    <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
      {/* Search */}
      <div className="relative w-full lg:max-w-sm">
        <SearchIcon className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-fg-subtle" />
        <input
          type="text"
          inputMode="search"
          value={query}
          onChange={(e) => onQuery(e.target.value)}
          placeholder="Search models, families, use cases…"
          aria-label="Search models"
          className="w-full rounded-lg border border-white/8 bg-white/5 py-2 pl-9 pr-9 text-sm text-fg placeholder:text-fg-subtle transition-colors focus:border-accent/60 focus:outline-none focus:ring-2 focus:ring-accent/25"
        />
        {query && (
          <button
            type="button"
            onClick={() => onQuery("")}
            aria-label="Clear search"
            className="absolute right-2 top-1/2 -translate-y-1/2 cursor-pointer rounded p-1 text-fg-subtle transition-colors hover:text-fg focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/45"
          >
            <XIcon className="size-3.5" />
          </button>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        {/* Status segmented control */}
        <div
          role="tablist"
          aria-label="Filter by install status"
          className="inline-flex rounded-lg border border-white/8 bg-white/5 p-0.5"
        >
          {STATUS_TABS.map((tab) => {
            const active = status === tab.key;
            return (
              <button
                key={tab.key}
                role="tab"
                aria-selected={active}
                onClick={() => onStatus(tab.key)}
                className={[
                  "cursor-pointer rounded-md px-3 py-1.5 text-xs font-medium transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/45",
                  active
                    ? "bg-accent/15 text-accent-text ring-1 ring-inset ring-accent/20"
                    : "text-fg-muted hover:text-fg",
                ].join(" ")}
              >
                {tab.label}
                <span className={["data ml-1.5", active ? "text-accent-text/70" : "text-fg-subtle"].join(" ")}>
                  {counts[tab.key]}
                </span>
              </button>
            );
          })}
        </div>

        {/* Family filter */}
        <SelectChip value={family} onChange={onFamily} ariaLabel="Filter by family">
          <option value="all">All families</option>
          {families.map((f) => (
            <option key={f} value={f}>
              {f}
            </option>
          ))}
        </SelectChip>

        {/* Sort */}
        <SelectChip value={sort} onChange={(v) => onSort(v as SortKey)} ariaLabel="Sort models">
          <option value="name">Name</option>
          <option value="params">Parameters</option>
          <option value="size">Size</option>
        </SelectChip>

        {/* View toggle — table is the default, cards the alternative */}
        <div role="group" aria-label="View" className="inline-flex rounded-lg border border-white/8 bg-white/5 p-0.5">
          {([
            { key: "table", label: "Table view", Icon: RowsIcon },
            { key: "cards", label: "Card view", Icon: GridIcon },
          ] as const).map(({ key, label, Icon }) => {
            const active = view === key;
            return (
              <button
                key={key}
                type="button"
                onClick={() => onView(key)}
                aria-pressed={active}
                aria-label={label}
                title={label}
                className={[
                  "cursor-pointer rounded-md p-1.5 transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/45",
                  active ? "bg-accent/15 text-accent-text ring-1 ring-inset ring-accent/20" : "text-fg-muted hover:text-fg",
                ].join(" ")}
              >
                <Icon className="size-4" />
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}

/** Native select dressed as a chip — appearance-none plus our own chevron. */
function SelectChip({
  value,
  onChange,
  ariaLabel,
  children,
}: {
  value: string;
  onChange: (v: string) => void;
  ariaLabel: string;
  children: React.ReactNode;
}) {
  return (
    <span className="relative inline-flex">
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        aria-label={ariaLabel}
        className="cursor-pointer appearance-none rounded-lg border border-white/8 bg-white/5 py-1.5 pl-2.5 pr-7 text-xs font-medium text-fg-muted transition-colors hover:border-white/15 hover:text-fg focus:border-accent/60 focus:outline-none focus:ring-2 focus:ring-accent/25 [&>option]:bg-surface [&>option]:text-fg"
      >
        {children}
      </select>
      <ChevronDownIcon className="pointer-events-none absolute right-2 top-1/2 size-3.5 -translate-y-1/2 text-fg-subtle" />
    </span>
  );
}
