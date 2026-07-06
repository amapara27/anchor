import { useEffect, useState } from "react";
import type { Tab } from "../types";
import { ColumnsIcon, HardDriveIcon, HomeIcon, LibraryIcon, PanelLeftIcon, SparkleIcon, WorkflowIcon } from "./icons";

interface SidebarProps {
  active: Tab;
  onSelect: (tab: Tab) => void;
}

const NAV: { tab: Tab; label: string; Icon: typeof HomeIcon }[] = [
  { tab: "home", label: "Home", Icon: HomeIcon },
  { tab: "search", label: "Discover", Icon: SparkleIcon },
  { tab: "models", label: "Model Library", Icon: LibraryIcon },
  { tab: "comparison", label: "Model Comparison", Icon: ColumnsIcon },
  { tab: "disk", label: "Disk Usage", Icon: HardDriveIcon },
  { tab: "workflows", label: "Workflow Library", Icon: WorkflowIcon },
];

const VERSION = "v0.1.0";
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
        "flex h-full shrink-0 flex-col border-r border-white/8 bg-chrome px-3 py-5 transition-[width] duration-300",
        "[transition-timing-function:var(--ease-out)]",
        collapsed ? "w-16" : "w-[260px]",
      ].join(" ")}
    >
      <div className={["flex items-center gap-2.5 px-1", collapsed ? "justify-center" : ""].join(" ")}>
        {/* Brand tile: flat neutral square with the mark in the single accent. */}
        <span className="flex size-8 shrink-0 items-center justify-center rounded-lg border border-white/8 bg-white/5">
          <AnchorMark className="size-5 text-accent-text" />
        </span>
        {!collapsed && (
          <span className="min-w-0 flex-1">
            <span className="block truncate text-lg font-semibold leading-tight tracking-tight text-fg">Anchor</span>
            <span className="label-caps block leading-tight">{VERSION}</span>
          </span>
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
                "flex h-[38px] w-full cursor-pointer items-center gap-2.5 rounded-r-lg border-l-2 text-sm font-medium transition-colors active:scale-[0.98]",
                "focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/45",
                collapsed ? "justify-center px-0" : "px-3",
                isActive
                  ? "border-accent bg-white/5 text-fg"
                  : "border-transparent text-fg-muted hover:bg-white/[0.03] hover:text-fg",
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
        <span className="size-1.5 shrink-0 rounded-full bg-ok" aria-hidden />
        {!collapsed && <span className="data truncate">100% local</span>}
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
