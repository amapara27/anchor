import type { Tab } from "../types";
import { SearchIcon } from "./icons";

const PAGE_LABEL: Record<Tab, string> = {
  home: "Home",
  search: "Discover",
  models: "Model Library",
  workflows: "Workflows",
  comparison: "Model Comparison",
  benchmarks: "Benchmarks",
  disk: "Disk Usage",
};

/**
 * Custom frameless top bar. The window uses macOS `titleBarStyle: "Overlay"`,
 * so the native traffic-lights float at the top-left — we reserve space for them
 * (`pl-20`) and make the whole strip a drag region. Interactive children opt out
 * of dragging by simply not carrying the `data-tauri-drag-region` attribute.
 */
export function TitleBar({ active, onOpenPalette }: { active: Tab; onOpenPalette?: () => void }) {
  return (
    <header
      data-tauri-drag-region
      className="relative z-30 flex h-16 shrink-0 select-none items-center border-b border-white/8 bg-chrome pl-20 pr-4"
    >
      {/* Left: current location, sitting just past the traffic-lights inset. */}
      <div data-tauri-drag-region className="flex min-w-0 items-center gap-2">
        <span className="text-[13px] font-semibold tracking-tight text-fg">
          Anchor
        </span>
        <span className="text-fg-subtle" aria-hidden>
          /
        </span>
        <span className="truncate text-[13px] font-medium text-fg-muted">{PAGE_LABEL[active]}</span>
      </div>

      {/* Center: command-palette trigger styled as the global search field. */}
      <button
        type="button"
        onClick={onOpenPalette}
        aria-label="Open command palette"
        className="absolute left-1/2 top-1/2 flex w-96 max-w-[40vw] -translate-x-1/2 -translate-y-1/2 cursor-pointer items-center gap-2.5 rounded-[var(--radius-control)] border border-white/8 bg-canvas px-3 py-2 text-left transition-colors duration-150 ease-out hover:border-white/15 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/45"
      >
        <SearchIcon className="size-4 shrink-0 text-fg-subtle" />
        <span className="flex-1 truncate text-sm text-fg-subtle">Search models, pages…</span>
        <kbd className="data shrink-0 text-[11px] leading-none tracking-tight text-fg-subtle">⌘ K</kbd>
      </button>
    </header>
  );
}
