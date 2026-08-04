import { useServerStatus } from "../lib/useServerStatus";
import { useTheme } from "../lib/useTheme";
import { ResidencyPill } from "./ResidencyPill";
import { SearchIcon } from "./icons";

/**
 * Custom frameless top bar. The window uses macOS `titleBarStyle: "Overlay"`,
 * so the native traffic-lights float at the top-left — we reserve space for them
 * (`pl-20`) and make the whole strip a drag region. Interactive children opt out
 * of dragging by simply not carrying the `data-tauri-drag-region` attribute.
 */
export function TitleBar({ onOpenPalette }: { onOpenPalette?: () => void }) {
  const { status } = useServerStatus();
  const { theme, toggle } = useTheme();
  const reachable = status?.reachable ?? false;

  return (
    <header
      data-tauri-drag-region
      className="relative z-30 flex h-[42px] shrink-0 select-none items-center gap-3.5 border-b border-hair bg-chrome pl-20 pr-3.5"
    >
      <span data-tauri-drag-region className="data text-[11px] uppercase tracking-[0.06em] text-fg-subtle">
        Anchor
      </span>

      <div data-tauri-drag-region className="flex-1" />

      <button
        type="button"
        onClick={onOpenPalette}
        aria-label="Search or run a command"
        className="flex h-[26px] cursor-pointer items-center gap-2 rounded-[7px] border border-hair bg-inset px-2.5 text-xs text-fg-subtle transition-colors duration-150 ease-out hover:border-hair2 hover:text-fg focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/45"
      >
        <SearchIcon className="size-3.5" />
        <span>Search or run a command</span>
        <kbd className="data rounded border border-hair px-1 py-px text-[10px] leading-none">⌘K</kbd>
      </button>

      {/* What's resident in RAM right now, with an eject. */}
      <ResidencyPill />

      {/* Live Ollama reachability — the one always-on status in the app. */}
      <div
        className="flex items-center gap-1.5 rounded-full border border-hair py-[3px] pl-[7px] pr-2.5"
        title={reachable ? "Ollama is reachable" : "Ollama is not running"}
      >
        <span
          className={`size-1.5 rounded-full ${reachable ? "animate-pulse-dot bg-ok" : "bg-fg-subtle"}`}
          aria-hidden
        />
        <span className="data text-[10.5px] text-fg-muted">
          {reachable ? `Ollama${status?.version ? ` · ${status.version}` : ""}` : "Ollama offline"}
        </span>
      </div>

      <button
        type="button"
        onClick={toggle}
        title="Toggle appearance"
        aria-label="Toggle appearance"
        className="data flex h-[26px] cursor-pointer items-center gap-2 rounded-full border border-hair px-2.5 text-[10.5px] text-fg-muted transition-colors duration-150 ease-out hover:border-hair2 hover:text-fg focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/45"
      >
        <span className="size-2.5 rounded-full bg-accent" aria-hidden />
        {theme === "dark" ? "Dark" : "Light"}
      </button>
    </header>
  );
}
