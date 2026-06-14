import type { Tab } from "../types";
import { SearchIcon } from "./icons";

const PAGE_LABEL: Record<Tab, string> = {
  home: "Home",
  models: "Model Library",
  workflows: "Workflows",
};

/**
 * Custom frameless title bar. The window uses macOS `titleBarStyle: "Overlay"`,
 * so the native traffic-lights float at the top-left — we reserve space for them
 * (`pl-20`) and make the whole strip a drag region. Interactive children opt out
 * of dragging by simply not carrying the `data-tauri-drag-region` attribute.
 */
export function TitleBar({ active }: { active: Tab }) {
  return (
    <header
      data-tauri-drag-region
      className="z-30 flex h-10 shrink-0 select-none items-center justify-between border-b border-white/8 bg-surface-solid/70 pl-20 pr-3 backdrop-blur-xl"
    >
      {/* Left: current location, sitting just past the traffic-lights inset. */}
      <div data-tauri-drag-region className="flex min-w-0 items-center gap-2">
        <span className="text-[11px] font-semibold uppercase tracking-[0.16em] text-accent-text/80">
          Anchor
        </span>
        <span className="text-fg-subtle" aria-hidden>
          /
        </span>
        <span className="truncate text-[13px] font-medium text-fg-muted">{PAGE_LABEL[active]}</span>
      </div>

      {/* Right: command-palette affordance (the shortcut UI lands with the palette). */}
      <div
        className="flex items-center gap-1.5 rounded-md border border-white/8 bg-white/[0.03] px-2 py-1 text-fg-subtle"
        title="Command palette — coming soon"
        aria-hidden
      >
        <SearchIcon className="size-3.5" />
        <kbd className="data text-[11px] leading-none tracking-tight">⌘K</kbd>
      </div>
    </header>
  );
}
