import { useCallback, useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { CheckIcon, ChevronDownIcon } from "../icons";

export interface SelectOption<T extends string = string> {
  value: T;
  /** Plain-text label. Also the type-ahead key and the trigger's fallback text. */
  label: string;
  /** Optional group heading; consecutive options sharing one are rendered together. */
  group?: string;
  disabled?: boolean;
  /** Free-form payload for `renderOption` / `renderValue` (fit tier, size, …). */
  meta?: unknown;
}

interface SelectProps<T extends string = string> {
  value: T | "";
  onChange: (value: T) => void;
  options: SelectOption<T>[];
  /** Shown when nothing is selected. */
  placeholder?: string;
  disabled?: boolean;
  /** `field` is the full-width form control; `pill` is the compact inline chip. */
  variant?: "field" | "pill";
  /** Accessible name. Pair with `label` for a visible one. */
  ariaLabel?: string;
  /** Visible mono caps label rendered above a `field`. */
  label?: string;
  className?: string;
  /** Custom row content. Falls back to the plain label. */
  renderOption?: (option: SelectOption<T>, selected: boolean) => ReactNode;
  /** Custom trigger content for the selected option. */
  renderValue?: (option: SelectOption<T>) => ReactNode;
  /** Popover width; defaults to matching the trigger. */
  menuWidth?: number | "trigger";
}

const MENU_MAX_HEIGHT = 320;
const TYPEAHEAD_RESET_MS = 600;

/**
 * The app's dropdown. Replaces every native `<select>`: macOS renders those with
 * its own system popup, which ignores the app's theme tokens entirely and can't
 * show per-row content (fit tier, size, status dot).
 *
 * A trigger button plus a listbox popover rendered through a portal — the portal
 * matters because triggers sit inside `overflow:hidden` toolbars and table
 * headers that would otherwise clip the menu.
 */
export function Select<T extends string = string>({
  value,
  onChange,
  options,
  placeholder = "Select…",
  disabled,
  variant = "field",
  ariaLabel,
  label,
  className = "",
  renderOption,
  renderValue,
  menuWidth = "trigger",
}: SelectProps<T>) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const [rect, setRect] = useState<DOMRect | null>(null);

  const triggerRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const typeahead = useRef({ query: "", at: 0 });
  const listboxId = useId();

  const selected = options.find((o) => o.value === value) ?? null;
  const enabled = options.map((o, i) => (o.disabled ? -1 : i)).filter((i) => i >= 0);

  const close = useCallback((refocus = true) => {
    setOpen(false);
    setActive(-1);
    if (refocus) triggerRef.current?.focus();
  }, []);

  const openMenu = useCallback(() => {
    if (disabled) return;
    const at = options.findIndex((o) => o.value === value && !o.disabled);
    setActive(at >= 0 ? at : (enabled[0] ?? -1));
    setOpen(true);
  }, [disabled, options, value, enabled]);

  const commit = useCallback(
    (index: number) => {
      const option = options[index];
      if (!option || option.disabled) return;
      onChange(option.value);
      close();
    },
    [options, onChange, close],
  );

  // Anchor the portal to the trigger, and follow it while scrolling/resizing.
  useLayoutEffect(() => {
    if (!open) return;
    const measure = () => setRect(triggerRef.current?.getBoundingClientRect() ?? null);
    measure();
    window.addEventListener("scroll", measure, true);
    window.addEventListener("resize", measure);
    return () => {
      window.removeEventListener("scroll", measure, true);
      window.removeEventListener("resize", measure);
    };
  }, [open]);

  // Close on any click that lands outside both the trigger and the menu.
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      const target = e.target as Node;
      if (triggerRef.current?.contains(target) || listRef.current?.contains(target)) return;
      close(false);
    };
    document.addEventListener("pointerdown", onPointerDown);
    return () => document.removeEventListener("pointerdown", onPointerDown);
  }, [open, close]);

  // Keep the highlighted row in view as it moves.
  useEffect(() => {
    if (!open || active < 0) return;
    listRef.current?.querySelector(`[data-index="${active}"]`)?.scrollIntoView({ block: "nearest" });
  }, [open, active]);

  const step = (from: number, delta: number) => {
    if (enabled.length === 0) return -1;
    const at = enabled.indexOf(from);
    if (at < 0) return delta > 0 ? enabled[0] : enabled[enabled.length - 1];
    return enabled[(at + delta + enabled.length) % enabled.length];
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (!open) {
      if (e.key === "Enter" || e.key === " " || e.key === "ArrowDown" || e.key === "ArrowUp") {
        e.preventDefault();
        openMenu();
      }
      return;
    }
    switch (e.key) {
      case "Escape":
        e.preventDefault();
        close();
        break;
      case "Tab":
        close(false);
        break;
      case "ArrowDown":
        e.preventDefault();
        setActive((a) => step(a, 1));
        break;
      case "ArrowUp":
        e.preventDefault();
        setActive((a) => step(a, -1));
        break;
      case "Home":
        e.preventDefault();
        setActive(enabled[0] ?? -1);
        break;
      case "End":
        e.preventDefault();
        setActive(enabled[enabled.length - 1] ?? -1);
        break;
      case "Enter":
      case " ":
        e.preventDefault();
        commit(active);
        break;
      default: {
        // Type-ahead: accumulate printable keys, jump to the first prefix match.
        if (e.key.length !== 1 || e.metaKey || e.ctrlKey) return;
        const now = Date.now();
        const t = typeahead.current;
        t.query = now - t.at > TYPEAHEAD_RESET_MS ? e.key : t.query + e.key;
        t.at = now;
        const q = t.query.toLowerCase();
        const hit = enabled.find((i) => options[i].label.toLowerCase().startsWith(q));
        if (hit != null) setActive(hit);
      }
    }
  };

  const isPill = variant === "pill";
  const triggerClass = isPill
    ? "flex h-[30px] items-center gap-2 rounded-[var(--radius-control)] border border-hair bg-surface px-2.5 text-fg"
    : "flex h-8 w-full items-center gap-2 rounded-[var(--radius-control)] border border-hair bg-surface px-3 text-fg";

  return (
    <div className={`min-w-0 ${className}`}>
      {label && <span className="label-caps mb-1.5 block">{label}</span>}
      <button
        ref={triggerRef}
        type="button"
        role="combobox"
        aria-expanded={open}
        aria-haspopup="listbox"
        aria-controls={open ? listboxId : undefined}
        aria-label={ariaLabel ?? label}
        disabled={disabled}
        onClick={() => (open ? close() : openMenu())}
        onKeyDown={onKeyDown}
        className={[
          triggerClass,
          "cursor-pointer text-left text-[12.5px] transition-colors duration-150 ease-out",
          "hover:border-hair2 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/45",
          "disabled:cursor-not-allowed disabled:opacity-50",
        ].join(" ")}
      >
        <span className="min-w-0 flex-1 truncate">
          {selected ? (
            (renderValue?.(selected) ?? selected.label)
          ) : (
            <span className="text-fg-subtle">{placeholder}</span>
          )}
        </span>
        <ChevronDownIcon
          className={`size-3 shrink-0 text-fg-subtle transition-transform duration-150 ease-out ${open ? "rotate-180" : ""}`}
        />
      </button>

      {open &&
        rect &&
        createPortal(
          <div
            ref={listRef}
            id={listboxId}
            role="listbox"
            aria-label={ariaLabel ?? label}
            aria-activedescendant={active >= 0 ? `${listboxId}-${active}` : undefined}
            style={{
              position: "fixed",
              // Flip above the trigger when the menu would overflow the viewport.
              top:
                rect.bottom + MENU_MAX_HEIGHT > window.innerHeight && rect.top > MENU_MAX_HEIGHT
                  ? undefined
                  : rect.bottom + 6,
              bottom:
                rect.bottom + MENU_MAX_HEIGHT > window.innerHeight && rect.top > MENU_MAX_HEIGHT
                  ? window.innerHeight - rect.top + 6
                  : undefined,
              left: rect.left,
              width: menuWidth === "trigger" ? rect.width : menuWidth,
              maxHeight: MENU_MAX_HEIGHT,
            }}
            className="scrollbar-slim z-50 animate-fade-in overflow-y-auto rounded-[var(--radius-card)] border border-hair bg-surface p-1 shadow-(--shadow-overlay)"
          >
            {options.length === 0 && <p className="px-2.5 py-2 text-[12.5px] text-fg-subtle">No options</p>}
            {options.map((option, i) => {
              const isSelected = option.value === value;
              const heading = option.group && option.group !== options[i - 1]?.group;
              return (
                <div key={option.value}>
                  {heading && <span className="label-caps block px-2.5 pb-1 pt-2">{option.group}</span>}
                  <div
                    id={`${listboxId}-${i}`}
                    data-index={i}
                    role="option"
                    aria-selected={isSelected}
                    aria-disabled={option.disabled || undefined}
                    onPointerEnter={() => !option.disabled && setActive(i)}
                    onClick={() => commit(i)}
                    className={[
                      "flex cursor-pointer items-center gap-2 rounded-[7px] px-2.5 py-1.5 text-[12.5px] transition-colors",
                      option.disabled ? "cursor-not-allowed opacity-40" : "",
                      active === i ? "bg-inset" : "",
                      isSelected ? "text-accent-text" : "text-fg",
                    ].join(" ")}
                  >
                    <span className="min-w-0 flex-1">
                      {renderOption?.(option, isSelected) ?? option.label}
                    </span>
                    {isSelected && <CheckIcon className="size-3.5 shrink-0 text-accent-text" />}
                  </div>
                </div>
              );
            })}
          </div>,
          document.body,
        )}
    </div>
  );
}
