/** One segment of a `Tabs` control. */
export interface TabItem<T extends string> {
  key: T;
  label: string;
  /** Optional trailing count, rendered mono and subdued. */
  count?: number | string;
}

/**
 * Segmented pill control — the app's in-page view switcher (Models, Agents,
 * Benchmarks). Distinct from the sidebar, which navigates between sections.
 */
export function Tabs<T extends string>({
  items,
  value,
  onChange,
  ariaLabel,
  className = "",
}: {
  items: TabItem<T>[];
  value: T;
  onChange: (key: T) => void;
  ariaLabel: string;
  className?: string;
}) {
  return (
    <div
      role="tablist"
      aria-label={ariaLabel}
      className={`inline-flex gap-0.5 rounded-[9px] border border-hair bg-inset p-[3px] ${className}`}
    >
      {items.map(({ key, label, count }) => {
        const active = key === value;
        return (
          <button
            key={key}
            type="button"
            role="tab"
            aria-selected={active}
            onClick={() => onChange(key)}
            className={[
              "flex cursor-pointer items-center gap-2 rounded-[7px] px-3 py-1.5 text-[12.5px] font-medium",
              "transition-colors duration-150 ease-out focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/45",
              active ? "bg-accent-soft text-accent-text" : "text-fg-muted hover:text-fg",
            ].join(" ")}
          >
            {label}
            {count != null && <span className="data text-[10px] text-fg-subtle">{count}</span>}
          </button>
        );
      })}
    </div>
  );
}
