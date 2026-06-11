import type { SortKey, StatusFilter } from "../types";
import { ChevronDownIcon, SearchIcon, XIcon } from "./icons";

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
}: ToolbarProps) {
  return (
    <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
      {/* Search */}
      <div className="relative w-full lg:max-w-sm">
        <SearchIcon className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-slate-500" />
        <input
          type="text"
          inputMode="search"
          value={query}
          onChange={(e) => onQuery(e.target.value)}
          placeholder="Search models, families, use cases…"
          aria-label="Search models"
          className="w-full rounded-lg border border-slate-800 bg-slate-900/70 py-2 pl-9 pr-9 text-sm text-slate-100 shadow-[inset_0_1px_2px_rgb(2_6_23/0.4)] placeholder:text-slate-500 backdrop-blur transition-colors focus:border-emerald-500/50 focus:outline-none focus:ring-2 focus:ring-emerald-500/20"
        />
        {query && (
          <button
            type="button"
            onClick={() => onQuery("")}
            aria-label="Clear search"
            className="absolute right-2 top-1/2 -translate-y-1/2 cursor-pointer rounded p-1 text-slate-500 transition-colors hover:text-slate-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/40"
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
          className="inline-flex rounded-lg border border-slate-800 bg-slate-900/70 p-0.5 backdrop-blur"
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
                  "cursor-pointer rounded-md px-3 py-1.5 text-xs font-medium transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/40 active:scale-[0.97]",
                  active
                    ? "bg-emerald-500/15 text-emerald-300 shadow-[inset_0_1px_0_rgb(255_255_255/0.04)] ring-1 ring-inset ring-emerald-500/20"
                    : "text-slate-400 hover:text-slate-200",
                ].join(" ")}
              >
                {tab.label}
                <span className={["tabular ml-1.5", active ? "text-emerald-400/70" : "text-slate-500"].join(" ")}>
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
        className="cursor-pointer appearance-none rounded-lg border border-slate-800 bg-slate-900/70 py-1.5 pl-2.5 pr-7 text-xs font-medium text-slate-300 backdrop-blur transition-colors hover:border-slate-700 hover:text-slate-100 focus:border-emerald-500/50 focus:outline-none focus:ring-2 focus:ring-emerald-500/20"
      >
        {children}
      </select>
      <ChevronDownIcon className="pointer-events-none absolute right-2 top-1/2 size-3.5 -translate-y-1/2 text-slate-500" />
    </span>
  );
}
