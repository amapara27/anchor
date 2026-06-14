import { useEffect, useState } from "react";
import type { Tab } from "../types";
import { HomeIcon, LibraryIcon, PanelLeftIcon, WorkflowIcon } from "./icons";

interface SidebarProps {
  active: Tab;
  onSelect: (tab: Tab) => void;
}

const NAV: { tab: Tab; label: string; Icon: typeof HomeIcon }[] = [
  { tab: "home", label: "Home", Icon: HomeIcon },
  { tab: "models", label: "Model Library", Icon: LibraryIcon },
  { tab: "workflows", label: "Workflow Library", Icon: WorkflowIcon },
];

const STORAGE_KEY = "anchor.sidebarCollapsed";
// Geometry for the sliding active indicator: item height + gap between items.
const ITEM_H = 38;
const GAP = 4;

/** Persistent, collapsible left navigation rail. */
export function Sidebar({ active, onSelect }: SidebarProps) {
  const [collapsed, setCollapsed] = useState<boolean>(() => {
    try {
      return localStorage.getItem(STORAGE_KEY) === "true";
    } catch {
      return false;
    }
  });

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, String(collapsed));
    } catch {
      // Storage may be unavailable; collapse state stays in-memory.
    }
  }, [collapsed]);

  const activeIndex = NAV.findIndex((n) => n.tab === active);

  return (
    <aside
      className={[
        "flex h-full shrink-0 flex-col border-r border-white/8 bg-surface-solid/60 px-3 py-5 backdrop-blur-xl transition-[width] duration-300",
        "[transition-timing-function:var(--ease-spring)]",
        collapsed ? "w-16" : "w-56",
      ].join(" ")}
    >
      <div className={["flex items-center gap-2.5 px-1", collapsed ? "justify-center" : ""].join(" ")}>
        {/* Brand tile: indigo→violet gradient + accent glow so the mark reads as identity. */}
        <span className="glow-accent flex size-8 shrink-0 items-center justify-center rounded-lg bg-gradient-to-br from-indigo-500 to-violet-600">
          <AnchorMark className="size-5 text-white" />
        </span>
        {!collapsed && (
          <span className="flex-1 truncate text-lg font-semibold tracking-tight text-fg">Anchor</span>
        )}
        {!collapsed && <ToggleButton collapsed={collapsed} onClick={() => setCollapsed((c) => !c)} />}
      </div>

      {collapsed && (
        <div className="mt-3 flex justify-center">
          <ToggleButton collapsed={collapsed} onClick={() => setCollapsed((c) => !c)} />
        </div>
      )}

      <nav className="relative mt-7 flex flex-col gap-1">
        {/* Sliding active indicator: one pill that springs between items (a11y: bg + bar, not colour-only). */}
        {activeIndex >= 0 && (
          <span
            className="pointer-events-none absolute inset-x-0 rounded-lg border-l-2 border-accent bg-accent/12 transition-transform duration-300 [transition-timing-function:var(--ease-spring)]"
            style={{ height: ITEM_H, transform: `translateY(${activeIndex * (ITEM_H + GAP)}px)` }}
            aria-hidden
          />
        )}
        {NAV.map(({ tab, label, Icon }) => {
          const isActive = active === tab;
          return (
            <button
              key={tab}
              type="button"
              onClick={() => onSelect(tab)}
              aria-current={isActive ? "page" : undefined}
              aria-label={collapsed ? label : undefined}
              title={collapsed ? label : undefined}
              style={{ height: ITEM_H }}
              className={[
                "relative z-10 flex w-full cursor-pointer items-center gap-2.5 rounded-lg text-sm font-medium transition-colors active:scale-[0.98]",
                "focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/45",
                collapsed ? "justify-center px-0" : "px-3",
                isActive ? "text-fg" : "text-fg-muted hover:text-fg",
              ].join(" ")}
            >
              <Icon className={["size-4 shrink-0", isActive ? "text-accent-text" : ""].join(" ")} />
              {!collapsed && label}
            </button>
          );
        })}
      </nav>

      {/* Footer: version + the local-first promise. Green dot = running locally. */}
      <div
        className={[
          "mt-auto flex items-center gap-2 border-t border-white/8 pt-4 text-[11px] text-fg-subtle",
          collapsed ? "justify-center px-0" : "px-2",
        ].join(" ")}
        title="Everything runs on this Mac"
      >
        <span className="size-1.5 shrink-0 rounded-full bg-emerald-400 shadow-[0_0_8px_rgb(52_211_153/0.7)]" aria-hidden />
        {!collapsed && <span className="data truncate">100% local · v0.1.0</span>}
      </div>
    </aside>
  );
}

function ToggleButton({ collapsed, onClick }: { collapsed: boolean; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={collapsed ? "Expand sidebar" : "Collapse sidebar"}
      aria-pressed={collapsed}
      title={collapsed ? "Expand sidebar" : "Collapse sidebar"}
      className="cursor-pointer rounded-md p-1.5 text-fg-subtle transition-colors hover:bg-white/6 hover:text-fg focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/45"
    >
      <PanelLeftIcon className="size-4" />
    </button>
  );
}

function AnchorMark({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={className}
      aria-hidden
    >
      <circle cx="12" cy="5" r="2.5" />
      <path d="M12 7.5V21" />
      <path d="M5 12H3a9 9 0 0 0 18 0h-2" />
      <path d="M8 12H16" />
    </svg>
  );
}
