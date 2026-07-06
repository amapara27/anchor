import type { SortKey, StatusFilter } from "../types";
import { ChevronDownIcon, GridIcon, RowsIcon, SearchIcon, XIcon } from "./icons";

/** Library layout: the dense table is the default; cards are the alternative. */
export type LibraryView = "table" | "cards";

const STATUS_TABS: { key: StatusFilter; label: string }[] = [
  { key: "all", label: "All" },
  { key: "installed", label: "Installed" },
  { key: "available", label: "Available" },
];

/** Left filter column: status + family as radio-behavior row lists. */
export function LibraryFilters({
  status,
  onStatus,
  family,
  onFamily,
  families,
  counts,
}: {
  status: StatusFilter;
  onStatus: (v: StatusFilter) => void;
  family: string;
  onFamily: (v: string) => void;
  families: string[];
  counts: Record<StatusFilter, number>;
}) {
  return (
    <div className="flex flex-col gap-3">
      <FilterCard label="Status" role="radiogroup">
        {STATUS_TABS.map((tab) => (
          <FilterRow
            key={tab.key}
            active={status === tab.key}
            onClick={() => onStatus(tab.key)}
            count={counts[tab.key]}
          >
            {tab.label}
          </FilterRow>
        ))}
      </FilterCard>

      <FilterCard label="Families" role="radiogroup">
        <FilterRow active={family === "all"} onClick={() => onFamily("all")}>
          All families
        </FilterRow>
        {families.map((f) => (
          <FilterRow key={f} active={family === f} onClick={() => onFamily(f)}>
            {f}
          </FilterRow>
        ))}
      </FilterCard>
    </div>
  );
}

function FilterCard({
  label,
  role,
  children,
}: {
  label: string;
  role?: string;
  children: React.ReactNode;
}) {
  return (
    <section className="card p-4">
      <h3 className="label-caps">{label}</h3>
      <div role={role} aria-label={`Filter by ${label.toLowerCase()}`} className="mt-2.5 flex flex-col gap-0.5">
        {children}
      </div>
    </section>
  );
}

function FilterRow({
  active,
  onClick,
  count,
  children,
}: {
  active: boolean;
  onClick: () => void;
  count?: number;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      role="radio"
      aria-checked={active}
      onClick={onClick}
      className={[
        "flex cursor-pointer items-center justify-between gap-2 rounded-md px-2 py-1.5 text-left text-sm transition-colors",
        "focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/45",
        active ? "bg-white/5 font-medium text-fg" : "text-fg-muted hover:bg-white/[0.03] hover:text-fg",
      ].join(" ")}
    >
      <span className="truncate">{children}</span>
      {count != null && (
        <span className={["data shrink-0 text-xs", active ? "text-accent-text" : "text-fg-subtle"].join(" ")}>
          {count}
        </span>
      )}
    </button>
  );
}

/** Slim bar above the grid: search, sort, and the table/cards view toggle. */
export function LibraryToolbar({
  query,
  onQuery,
  sort,
  onSort,
  view,
  onView,
}: {
  query: string;
  onQuery: (v: string) => void;
  sort: SortKey;
  onSort: (v: SortKey) => void;
  view: LibraryView;
  onView: (v: LibraryView) => void;
}) {
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
