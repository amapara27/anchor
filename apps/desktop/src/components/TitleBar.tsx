import { useServerStatus } from "../lib/useServerStatus";
import { useTheme } from "../lib/useTheme";
import { ResidencyPill } from "./ResidencyPill";
import { SearchIcon, SidebarIcon, SunIcon } from "./icons";

/**
 * Custom frameless top bar. The window uses macOS `titleBarStyle: "Overlay"`,
 * so the native traffic-lights float at the top-left — we reserve space for them
 * (`pl-20`) and make the whole strip a drag region. Interactive children opt out
 * of dragging by simply not carrying the `data-tauri-drag-region` attribute.
 */
export function TitleBar({ onOpenPalette, collapsed, onToggleSidebar }: { onOpenPalette: () => void; collapsed: boolean; onToggleSidebar: () => void }) {
  const { status, loading } = useServerStatus();
  const { theme, toggle } = useTheme();
  const reachable = status?.reachable ?? false;

  return (
    <header
      data-tauri-drag-region
      className="relative z-30 flex h-[48px] shrink-0 select-none items-center gap-4 border-b border-hair bg-chrome pl-20 pr-4"
    >
      <button type="button" onClick={onToggleSidebar} aria-label="Toggle tool sidebar" aria-expanded={!collapsed} title="Toggle tool sidebar" className="rounded p-1 text-fg-muted hover:text-fg">
        <SidebarIcon className="size-4" />
      </button>
      <span data-tauri-drag-region className="text-sm font-semibold tracking-tight text-fg">
        Anchor
      </span>
      <span data-tauri-drag-region className="titlebar-workspace border-l border-hair pl-4 text-xs text-fg-muted">Workspace</span>

      <div data-tauri-drag-region className="flex-1" />

      <button
        type="button"
        onClick={onOpenPalette}
        aria-label="Search or run a command"
        className="flex h-[30px] cursor-pointer items-center gap-2 rounded-control border border-hair px-2.5 text-xs text-fg-muted transition-colors duration-150 ease-out hover:border-hair2 hover:text-fg focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/45"
      >
        <SearchIcon className="size-3.5" />
        <span>Search</span>
        <kbd className="data ml-5 rounded bg-raised px-1 py-0.5 text-[10px] leading-none">⌘K</kbd>
      </button>

      {/* What's resident in RAM right now, with an eject. */}
      <div className="titlebar-residency"><ResidencyPill /></div>

      {/* Live Ollama reachability — the one always-on status in the app. */}
      <div
        className="flex items-center gap-2 text-xs"
        title={reachable ? "Ollama is reachable" : "Ollama is not running"}
      >
        <span
          className={`size-1.5 rounded-full ${reachable ? "bg-ok" : "bg-fg-subtle"}`}
          aria-hidden
        />
        <span className="text-[11px] text-fg-muted">
          {reachable ? <>Ollama<span className="titlebar-server-version data">{status?.version ? ` ${status.version}` : ""}</span></> : loading ? "Connecting…" : "Ollama offline"}
        </span>
      </div>

      <button
        type="button"
        onClick={toggle}
        title="Toggle appearance"
        aria-label="Toggle appearance"
        className="flex size-7 cursor-pointer items-center justify-center rounded text-fg-muted transition-colors duration-150 ease-out hover:text-fg focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/45"
      >
        <SunIcon className="size-4" />
        <span className="sr-only">{theme === "dark" ? "Dark" : "Light"}</span>
      </button>
    </header>
  );
}
