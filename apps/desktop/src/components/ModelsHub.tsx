import { useEffect, useState } from "react";
import type { ModelsTab } from "../types";
import { ColumnsIcon, HardDriveIcon, LibraryIcon, SparkleIcon, ZapIcon } from "./icons";
import { SearchPage } from "./SearchPage";
import { ModelLibrary } from "./ModelLibrary";
import { ModelComparison } from "./ModelComparison";
import { BenchmarksPage } from "./BenchmarksPage";
import { DiskPage } from "./DiskPage";

interface ModelsHubProps {
  /** Jump target from the command palette; opens a model's detail drawer. */
  openModel: { id: string; nonce: number } | null;
  initialTab?: ModelsTab;
}

const SUBTABS: { key: ModelsTab; label: string; Icon: typeof LibraryIcon }[] = [
  { key: "explore", label: "Explore", Icon: SparkleIcon },
  { key: "installed", label: "Installed", Icon: LibraryIcon },
  { key: "compare", label: "Compare", Icon: ColumnsIcon },
  { key: "benchmark", label: "Benchmark", Icon: ZapIcon },
  { key: "disk", label: "Disk", Icon: HardDriveIcon },
];

/** Model-management hub: one nav item, five sub-views over the existing pages. */
export function ModelsHub({ openModel, initialTab = "installed" }: ModelsHubProps) {
  const [sub, setSub] = useState<ModelsTab>(initialTab);

  // A palette jump-to-model lands on the Installed view where the drawer lives.
  useEffect(() => {
    if (openModel) setSub("installed");
  }, [openModel]);
  // A palette page command (Compare/Benchmark/…) sets the target sub-view.
  useEffect(() => setSub(initialTab), [initialTab]);

  return (
    <div className="space-y-6">
      {/* Sub-nav mirrors LibraryToolbar's segmented-control idiom. */}
      <div role="tablist" aria-label="Models" className="inline-flex rounded-lg border border-white/8 bg-white/5 p-0.5">
        {SUBTABS.map(({ key, label, Icon }) => {
          const active = sub === key;
          return (
            <button
              key={key}
              type="button"
              role="tab"
              aria-selected={active}
              onClick={() => setSub(key)}
              className={[
                "flex cursor-pointer items-center gap-2 rounded-md px-3 py-1.5 text-sm font-medium transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/45",
                active ? "bg-accent/15 text-accent-text ring-1 ring-inset ring-accent/20" : "text-fg-muted hover:text-fg",
              ].join(" ")}
            >
              <Icon className="size-4" />
              {label}
            </button>
          );
        })}
      </div>

      {sub === "explore" && <SearchPage />}
      {sub === "installed" && <ModelLibrary openModel={openModel} />}
      {sub === "compare" && <ModelComparison />}
      {sub === "benchmark" && <BenchmarksPage />}
      {sub === "disk" && <DiskPage />}
    </div>
  );
}
