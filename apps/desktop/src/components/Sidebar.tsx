import { useMemo } from "react";
import type { Tab } from "../types";
import { useModels } from "../lib/useModels";
import { useHardwareProfile } from "../lib/useHardwareProfile";
import { formatBytes } from "../lib/format";
import { Meter } from "./ui/SegmentedBar";
import { BarChartIcon, ChatIcon, CubeIcon, DatabaseIcon, SettingsIcon } from "./icons";

interface SidebarProps {
  active: Tab;
  onSelect: (tab: Tab) => void;
}

type NavItem = { tab: Tab; label: string; Icon: typeof ChatIcon };

// Workspace leads with use (chat); Manage is the tooling around it.
const NAV_GROUPS: { heading: string; items: NavItem[] }[] = [
  {
    heading: "Workspace",
    items: [{ tab: "chat", label: "Chat", Icon: ChatIcon }],
  },
  {
    heading: "Manage",
    items: [
      { tab: "models", label: "Models", Icon: CubeIcon },
      { tab: "storage", label: "Storage", Icon: DatabaseIcon },
      { tab: "benchmarks", label: "Benchmarks", Icon: BarChartIcon },
      { tab: "settings", label: "Settings", Icon: SettingsIcon },
    ],
  },
];

const VERSION = "v0.1.0";

/** Persistent left navigation rail. */
export function Sidebar({ active, onSelect }: SidebarProps) {
  const { models } = useModels();
  const { profile } = useHardwareProfile();

  // Real headroom: installed model weights against this Mac's unified memory.
  const weightsBytes = useMemo(
    () => models.filter((m) => m.status === "installed").reduce((sum, m) => sum + (m.size_bytes ?? 0), 0),
    [models],
  );
  const memoryBytes = profile?.memory_bytes ?? null;
  const fraction = memoryBytes && memoryBytes > 0 ? weightsBytes / memoryBytes : 0;

  return (
    <aside className="flex h-full w-[216px] shrink-0 flex-col gap-0.5 border-r border-hair bg-chrome px-2.5 py-3.5">
      <div className="flex items-center gap-2.5 px-1.5 pb-3.5 pt-0.5">
        <span className="flex size-7 shrink-0 items-center justify-center rounded-lg border border-hair bg-accent-soft">
          <AnchorMark className="size-4 text-accent-text" />
        </span>
        <span className="flex min-w-0 flex-col leading-tight">
          <span className="truncate text-[15px] font-semibold tracking-tight text-fg">Anchor</span>
          <span className="data text-[10px] text-fg-subtle">{VERSION}</span>
        </span>
      </div>

      <nav className="flex flex-col gap-0.5">
        {NAV_GROUPS.map((group) => (
          <div key={group.heading} className="flex flex-col gap-0.5">
            <span className="label-caps px-2 pb-1 pt-3.5 first:pt-1.5">{group.heading}</span>
            {group.items.map(({ tab, label, Icon }) => {
              const isActive = active === tab;
              return (
                <button
                  key={tab}
                  type="button"
                  onClick={() => onSelect(tab)}
                  aria-current={isActive ? "page" : undefined}
                  className={[
                    "flex h-[34px] w-full cursor-pointer items-center gap-2.5 rounded-lg px-2.5 text-left text-[13.5px] font-medium",
                    "transition-colors duration-150 ease-out focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/45",
                    isActive ? "bg-accent-soft text-fg" : "text-fg-muted hover:bg-inset hover:text-fg",
                  ].join(" ")}
                >
                  <Icon className={`size-4 shrink-0 ${isActive ? "text-accent-text" : ""}`} />
                  {label}
                </button>
              );
            })}
          </div>
        ))}
      </nav>

      {/* Footer: unified-memory headroom + the local-first promise. */}
      <div className="mt-auto flex flex-col gap-2 border-t border-hair px-1 pt-3.5">
        {memoryBytes != null && (
          <>
            <div className="data flex justify-between gap-2 whitespace-nowrap text-[10.5px] text-fg-subtle">
              <span>Memory</span>
              <span className="text-fg-muted">
                {formatBytes(weightsBytes)} / {formatBytes(memoryBytes)}
              </span>
            </div>
            <Meter fraction={fraction} />
          </>
        )}
        <div
          className="data flex items-center gap-1.5 text-[10.5px] text-fg-subtle"
          title="Everything runs on this Mac"
        >
          <span className="size-[5px] shrink-0 rounded-full bg-ok" aria-hidden />
          100% local
        </div>
      </div>
    </aside>
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
      <circle cx="12" cy="3.6" r="2" />
      <path d="M12 5.6v15.2" />
      <path d="M8.2 8.6h7.6" />
      <path d="M3.5 12.9a8.5 8.5 0 0 0 8.5 7.9 8.5 8.5 0 0 0 8.5-7.9" />
      <path d="M3.5 12.9 1.7 11.2M3.5 12.9l2.3-.6M20.5 12.9l1.8-1.7M20.5 12.9l-2.3-.6" />
    </svg>
  );
}
