/** One segment of a `Tabs` control. */
export interface TabItem<T extends string> {
  key: T;
  label: string;
  /** Optional trailing count, rendered mono and subdued. */
  count?: number | string;
}

/**
 * Underline tabs for views within a tool.
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
      className={`tool-tabs ${className}`}
    >
      {items.map(({ key, label, count }) => {
        const active = key === value;
        return (
          <button
            key={key}
            type="button"
            role="tab"
            aria-label={label}
            aria-selected={active}
            tabIndex={active ? 0 : -1}
            onKeyDown={e => {
              const index = items.findIndex(item => item.key === key);
              const next = e.key === "ArrowRight" ? (index + 1) % items.length : e.key === "ArrowLeft" ? (index + items.length - 1) % items.length : e.key === "Home" ? 0 : e.key === "End" ? items.length - 1 : null;
              if (next === null) return;
              e.preventDefault();
              onChange(items[next].key);
              (e.currentTarget.parentElement?.children[next] as HTMLElement)?.focus();
            }}
            onClick={() => onChange(key)}
            className={[
              "tool-tab text-[13px] transition-colors duration-150",
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
