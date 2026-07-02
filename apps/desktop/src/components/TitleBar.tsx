import type { Tab } from "../types";
import { SearchIcon } from "./icons";

const PAGE_LABEL: Record<Tab, string> = {
  home: "Home",
  search: "Discover",
  models: "Model Library",
  workflows: "Workflows",
  comparison: "Model Comparison",
};

/**
 * Custom frameless title bar. The window uses macOS `titleBarStyle: "Overlay"`,
 * so the native traffic-lights float at the top-left — we reserve space for them
 * (`pl-20`) and make the whole strip a drag region. Interactive children opt out
 * of dragging by simply not carrying the `data-tauri-drag-region` attribute.
 */
export function TitleBar({ active, onOpenPalette }: { active: Tab; onOpenPalette?: () => void }) {
  return (
    <header
      data-tauri-drag-region
      className="z-30 flex h-10 shrink-0 select-none items-center justify-between border-b border-white/8 bg-chrome pl-20 pr-3"
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

      {/* Right: command-palette trigger. */}
      <button
        type="button"
        onClick={onOpenPalette}
        title="Command palette"
        aria-label="Open command palette"
        className="flex cursor-pointer items-center gap-1.5 rounded-md border border-white/8 bg-white/[0.03] px-2 py-1 text-fg-subtle transition-colors duration-150 ease-out hover:border-white/15 hover:text-fg focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/45"
      >
        <SearchIcon className="size-3.5" />
        <kbd className="data text-[11px] leading-none tracking-tight">⌘K</kbd>
      </button>
    </header>
  );
}
