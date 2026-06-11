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

  return (
    <aside
      className={[
        "sticky top-0 flex h-dvh shrink-0 flex-col border-r border-slate-800/80 bg-surface/80 px-3 py-5 backdrop-blur transition-[width] duration-200",
        collapsed ? "w-16" : "w-56",
      ].join(" ")}
    >
      <div className={["flex items-center gap-2.5 px-1", collapsed ? "justify-center" : ""].join(" ")}>
        {/* Brand tile: emerald gradient + soft glow so the mark reads as the app's identity. */}
        <span className="glow-accent flex size-8 shrink-0 items-center justify-center rounded-lg bg-gradient-to-br from-emerald-400 to-teal-600">
          <AnchorMark className="size-5 text-slate-950" />
        </span>
        {!collapsed && (
          <span className="flex-1 truncate text-lg font-semibold tracking-tight text-slate-50">Anchor</span>
        )}
        {!collapsed && <ToggleButton collapsed={collapsed} onClick={() => setCollapsed((c) => !c)} />}
      </div>

      {collapsed && (
        <div className="mt-3 flex justify-center">
          <ToggleButton collapsed={collapsed} onClick={() => setCollapsed((c) => !c)} />
        </div>
      )}

      <nav className="mt-7 flex flex-col gap-1">
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
              className={[
                "relative flex w-full cursor-pointer items-center gap-2.5 rounded-lg py-2 text-sm font-medium transition-colors active:scale-[0.98]",
                "focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/40",
                collapsed ? "justify-center px-0" : "px-3",
                isActive
                  ? "bg-slate-800/70 text-slate-100 shadow-[inset_0_1px_0_rgb(255_255_255/0.04)]"
                  : "text-slate-400 hover:bg-slate-800/40 hover:text-slate-200",
              ].join(" ")}
            >
              {/* Active rail: a slim emerald bar marks the current page (a11y: not colour-only — bg + bar). */}
              {isActive && !collapsed && (
                <span className="absolute left-0 top-1/2 h-4 w-0.5 -translate-y-1/2 rounded-full bg-emerald-400" aria-hidden />
              )}
              <Icon className={["size-4 shrink-0", isActive ? "text-emerald-400" : ""].join(" ")} />
              {!collapsed && label}
            </button>
          );
        })}
      </nav>

      {/* Footer: version + the local-first promise. */}
      <div
        className={[
          "mt-auto flex items-center gap-2 border-t border-slate-800/70 pt-4 text-[11px] text-slate-500",
          collapsed ? "justify-center px-0" : "px-2",
        ].join(" ")}
        title="Everything runs on this Mac"
      >
        <span className="size-1.5 shrink-0 rounded-full bg-emerald-400/80" aria-hidden />
        {!collapsed && <span className="truncate">100% local · v0.1.0</span>}
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
      className="cursor-pointer rounded-md p-1.5 text-slate-500 transition-colors hover:bg-slate-800/40 hover:text-slate-200 focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/40"
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
