import { useEffect, useMemo, useState } from "react";
import type { ModelsTab } from "../types";
import { useModels } from "../lib/useModels";
import { useFavorites } from "../lib/useFavorites";
import { useHardwareProfile } from "../lib/useHardwareProfile";
import { getLastUsed } from "../lib/lastUsed";
import { formatBytes, formatContext, formatParams, formatTokSec } from "../lib/format";
import { DEFAULT_CONTEXT } from "../lib/fit";
import { hardwareHint } from "../lib/hint";
import { PageHeader, PrimaryButton } from "./PageHeader";
import { Tabs } from "./ui/Tabs";
import { Meter, SegmentedBar } from "./ui/SegmentedBar";
import { ModelDetailAside } from "./ModelDetailAside";
import { SearchPage } from "./SearchPage";
import { ModelComparison } from "./ModelComparison";
import { DownloadIcon, RefreshIcon, SearchIcon } from "./icons";

interface ModelsHubProps {
  /** Jump target from the command palette; selects a model in the aside. */
  openModel: { id: string; nonce: number } | null;
  initialTab?: ModelsTab;
}

const STALE_MS = 30 * 86_400_000;

const FIT_TONE: Record<string, { color: string; label: string }> = {
  ok: { color: "var(--ok)", label: "fits" },
  tight: { color: "var(--warn)", label: "tight" },
  wont_fit: { color: "var(--danger)", label: "won't fit" },
  unknown: { color: "var(--hair2)", label: "—" },
};

/** Quick filters over the installed list. */
const CHIPS = ["Fits now", "Favourites", "Stale"] as const;
type Chip = (typeof CHIPS)[number];

const COLUMNS = "grid-cols-[minmax(0,1.6fr)_66px_84px_62px_74px_96px_90px]";

/** Model management: the installed library, discovery, and side-by-side compare. */
export function ModelsHub({ openModel, initialTab = "installed" }: ModelsHubProps) {
  const { models, loading, error, downloads, reload, startDownload, removeModel } = useModels();
  const { isFavorite } = useFavorites();
  const { profile } = useHardwareProfile();

  const [tab, setTab] = useState<ModelsTab>(initialTab);
  const [query, setQuery] = useState("");
  const [chips, setChips] = useState<Record<Chip, boolean>>({
    "Fits now": false,
    Favourites: false,
    Stale: false,
  });
  const [selectedId, setSelectedId] = useState<string | null>(null);

  const totalMemoryBytes = profile?.memory_bytes ?? null;
  const chip = profile?.chip ?? null;

  // A palette jump lands on Installed with that model selected in the aside.
  useEffect(() => {
    if (openModel?.id) {
      setTab("installed");
      setSelectedId(openModel.id);
    }
  }, [openModel]);
  useEffect(() => setTab(initialTab), [initialTab]);

  const installed = useMemo(() => models.filter((m) => m.status === "installed"), [models]);

  // Every installed model, decorated with the derived figures the table shows.
  const rows = useMemo(() => {
    const now = Date.now();
    return installed.map((m) => {
      const hint = hardwareHint(
        {
          id: m.id,
          params_b: m.spec.params_b,
          quant: m.spec.quant,
          contextTokens: m.spec.context_tokens || DEFAULT_CONTEXT,
          arch: m.arch,
          sizeBytes: m.size_bytes,
        },
        { memory_bytes: totalMemoryBytes, chip },
      );
      const { fit, tps } = hint;
      const lastUsed = getLastUsed(m.id);
      return {
        model: m,
        fit,
        tps,
        stale: lastUsed == null || now - lastUsed > STALE_MS,
        // Share of memory the model needs — the width of its fit meter.
        load: fit.breakdown.availableGB > 0 ? fit.breakdown.totalNeededGB / fit.breakdown.availableGB : 0,
      };
    });
  }, [installed, totalMemoryBytes, chip]);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return rows.filter((r) => {
      if (q && !`${r.model.name} ${r.model.family} ${r.model.spec.blurb}`.toLowerCase().includes(q)) return false;
      if (chips["Fits now"] && r.fit.tier !== "ok") return false;
      if (chips.Favourites && !isFavorite(r.model.id)) return false;
      if (chips.Stale && !r.stale) return false;
      return true;
    });
  }, [rows, query, chips, isFavorite]);

  const selected = models.find((m) => m.id === selectedId) ?? null;

  // Headroom bar: active weights vs stale weights against unified memory.
  const weightsBytes = installed.reduce((sum, m) => sum + (m.size_bytes ?? 0), 0);
  const staleBytes = rows.filter((r) => r.stale).reduce((sum, r) => sum + (r.model.size_bytes ?? 0), 0);
  const headroom =
    totalMemoryBytes && totalMemoryBytes > 0
      ? [
          {
            label: "active",
            fraction: (weightsBytes - staleBytes) / totalMemoryBytes,
            color: "var(--accent)",
            detail: formatBytes(weightsBytes - staleBytes),
          },
          {
            label: "stale",
            fraction: staleBytes / totalMemoryBytes,
            color: "var(--hair2)",
            detail: formatBytes(staleBytes),
          },
        ]
      : [];

  return (
    <>
      <div className="scrollbar-slim min-w-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex max-w-[1180px] flex-col gap-[18px] px-7 pb-9 pt-6">
          <PageHeader
            eyebrow="Manage"
            title="Models"
            actions={
              <>
                <label className="flex h-8 w-[230px] items-center gap-2 rounded-lg border border-hair bg-surface px-2.5">
                  <SearchIcon className="size-3.5 shrink-0 text-fg-subtle" />
                  <input
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    placeholder="Search installed models…"
                    aria-label="Search models"
                    className="min-w-0 flex-1 bg-transparent text-[12.5px] text-fg placeholder:text-fg-subtle focus:outline-none"
                  />
                </label>
                <PrimaryButton onClick={() => setTab("discover")}>
                  <DownloadIcon className="size-3.5" />
                  Pull model
                </PrimaryButton>
              </>
            }
          />

          {totalMemoryBytes != null && (
            <section className="card flex flex-col gap-2.5 p-4">
              <div className="flex flex-wrap items-baseline gap-2.5">
                <span className="label-caps">
                  Headroom · {chip ?? "this Mac"} · {formatBytes(totalMemoryBytes)} unified
                </span>
                <span className="data ml-auto text-[11.5px] text-fg-muted">
                  {installed.length} installed · {formatBytes(weightsBytes)} on disk
                  {staleBytes > 0 && ` · ${formatBytes(staleBytes)} reclaimable`}
                </span>
              </div>
              <SegmentedBar segments={headroom} height={9} legend />
            </section>
          )}

          <div className="flex flex-wrap items-center gap-2.5">
            <Tabs
              ariaLabel="Models view"
              value={tab}
              onChange={setTab}
              items={[
                { key: "installed", label: "Installed", count: installed.length },
                { key: "discover", label: "Discover" },
                { key: "compare", label: "Compare" },
              ]}
            />
            {tab === "installed" && (
              <>
                <div className="flex flex-wrap gap-1.5">
                  {CHIPS.map((label) => {
                    const on = chips[label];
                    return (
                      <button
                        key={label}
                        type="button"
                        aria-pressed={on}
                        onClick={() => setChips((c) => ({ ...c, [label]: !c[label] }))}
                        className={[
                          "flex h-7 cursor-pointer items-center rounded-full border px-3 text-xs transition-colors duration-150 ease-out",
                          "focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/45",
                          on
                            ? "border-accent-line bg-accent-soft text-accent-text"
                            : "border-hair text-fg-muted hover:border-hair2 hover:text-fg",
                        ].join(" ")}
                      >
                        {label}
                      </button>
                    );
                  })}
                </div>
                <span className="data ml-auto text-[11px] text-fg-subtle">
                  {visible.length} of {installed.length} installed
                </span>
              </>
            )}
          </div>

          {error && (
            <div className="flex items-center gap-3 rounded-[var(--radius-card)] border border-hair bg-inset px-4 py-3">
              <p className="min-w-0 flex-1 truncate text-xs text-fg-muted" title={error}>
                Couldn’t confirm installed models — showing the catalog. ({error})
              </p>
              <button
                type="button"
                onClick={reload}
                className="flex shrink-0 cursor-pointer items-center gap-1.5 rounded-lg border border-hair px-2.5 py-1 text-xs text-fg-muted transition-colors hover:border-hair2 hover:text-fg"
              >
                <RefreshIcon className="size-3.5" /> Retry
              </button>
            </div>
          )}

          {tab === "installed" &&
            (loading ? (
              <div className="card shimmer h-64" aria-hidden />
            ) : visible.length === 0 ? (
              <p className="card px-4 py-10 text-center text-sm text-fg-subtle">
                {installed.length === 0
                  ? "No models installed yet — pull one from Discover."
                  : "No installed models match those filters."}
              </p>
            ) : (
              <section className="card overflow-hidden">
                <div className={`label-caps grid ${COLUMNS} gap-3 border-b border-hair bg-inset px-4 py-2.5`}>
                  <span>Model</span>
                  <span className="text-right">Params</span>
                  <span>Quant</span>
                  <span className="text-right">Ctx</span>
                  <span className="text-right">Disk</span>
                  <span>Fit</span>
                  <span className="text-right">Speed</span>
                </div>
                {visible.map(({ model, fit, tps, load }) => {
                  const tone = FIT_TONE[fit.tier];
                  return (
                    <button
                      key={model.id}
                      type="button"
                      onClick={() => setSelectedId(model.id)}
                      className={[
                        `grid w-full ${COLUMNS} cursor-pointer items-center gap-3 border-b border-hair px-4 py-2.5 text-left`,
                        "transition-colors duration-150 ease-out hover:bg-inset",
                        model.id === selectedId ? "bg-inset shadow-[inset_2px_0_0_var(--accent)]" : "",
                      ].join(" ")}
                    >
                      <span className="flex min-w-0 items-center gap-2.5">
                        <span className="size-1.5 shrink-0 rounded-full bg-ok" aria-hidden />
                        <span className="flex min-w-0 flex-col gap-0.5">
                          <span className="data truncate text-[12.5px] font-medium text-fg">{model.name}</span>
                          <span className="truncate text-[11px] text-fg-subtle">{model.spec.blurb}</span>
                        </span>
                      </span>
                      <span className="data text-right text-[11.5px] text-fg-muted">
                        {formatParams(model.spec.params_b)}
                      </span>
                      <span className="data text-[11.5px] text-fg-muted">{model.spec.quant}</span>
                      <span className="data text-right text-[11.5px] text-fg-muted">
                        {formatContext(model.spec.context_tokens)}
                      </span>
                      <span className="data text-right text-[11.5px] text-fg-muted">
                        {formatBytes(model.size_bytes)}
                      </span>
                      <span className="flex items-center gap-2">
                        <Meter fraction={load} color={tone.color} className="flex-1" />
                        <span className="data text-[10px]" style={{ color: tone.color }}>
                          {tone.label}
                        </span>
                      </span>
                      <span className="data text-right text-[11.5px] text-fg-muted">
                        {tps ? formatTokSec(tps.value) : "—"}
                      </span>
                    </button>
                  );
                })}
              </section>
            ))}

          {tab === "discover" && <SearchPage />}
          {tab === "compare" && <ModelComparison />}
        </div>
      </div>

      {tab !== "compare" && (
        <ModelDetailAside
          model={selected}
          download={selected ? downloads[selected.id] : undefined}
          totalMemoryBytes={totalMemoryBytes}
          chip={chip}
          onDownload={() => selected && startDownload(selected)}
          onRemove={() => {
            if (!selected) return;
            removeModel(selected.id);
            setSelectedId(null);
          }}
          onOpenInChat={() => {}}
          onBenchmark={() => {}}
        />
      )}
    </>
  );
}
