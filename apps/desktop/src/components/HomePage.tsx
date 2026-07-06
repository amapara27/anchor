import { useMemo } from "react";
import type { HardwareProfile, LibraryModel, Tab } from "../types";
import { useModels } from "../lib/useModels";
import { useFavorites } from "../lib/useFavorites";
import { useHardwareProfile } from "../lib/useHardwareProfile";
import { formatBytes } from "../lib/format";
import { ModelCard } from "./ModelCard";
import { PageHeader } from "./PageHeader";
import { StatTile } from "./ui/StatTile";
import { SectionHeading } from "./ui/SectionHeading";
import { Button } from "./ui/Button";
import { ChipIcon, RefreshIcon, StarIcon } from "./icons";

interface HomePageProps {
  onNavigate: (tab: Tab) => void;
}

/** Landing page: hardware/model-status bento + favorites. */
export function HomePage({ onNavigate }: HomePageProps) {
  const { models, downloads, startDownload, cancelDownload } = useModels();
  const { isFavorite, toggleFavorite } = useFavorites();
  const { profile, loading: hwLoading, refresh: refreshHardware } = useHardwareProfile();
  const totalMemoryBytes = profile?.memory_bytes ?? null;

  const installed = useMemo(() => models.filter((m) => m.status === "installed"), [models]);
  const stats = useMemo(() => {
    const onDisk = installed.reduce((sum, m) => sum + (m.size_bytes ?? 0), 0);
    const families = new Set(installed.map((m) => m.family));
    return { installed: installed.length, onDisk, families: families.size };
  }, [installed]);

  const favorites = useMemo(() => models.filter((m) => isFavorite(m.id)), [models, isFavorite]);

  return (
    <div className="space-y-10">
      <PageHeader eyebrow="Overview" title="Home" subtitle="Your local AI at a glance." />

      <section className="grid grid-cols-12 gap-4">
        <HardwareHero
          profile={profile}
          loading={hwLoading}
          onRefresh={refreshHardware}
          modelsBytes={stats.onDisk}
        />
        <ModelStatusCard installed={installed} stats={stats} favorites={favorites.length} onNavigate={onNavigate} />
        <ModelSizesCard installed={installed} />
      </section>

      <section className="space-y-4">
        <SectionHeading
          action={
            <Button variant="text" className="px-0" onClick={() => onNavigate("models")}>
              Library
            </Button>
          }
        >
          Favorites
        </SectionHeading>
        {favorites.length > 0 ? (
          <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
            {favorites.map((m) => (
              <ModelCard
                key={m.id}
                model={m}
                download={downloads[m.id]}
                selected={false}
                onSelect={() => onNavigate("models")}
                onDownload={() => startDownload(m)}
                onCancel={() => cancelDownload(m.id)}
                favorite
                onToggleFavorite={() => toggleFavorite(m.id)}
                totalMemoryBytes={totalMemoryBytes}
              />
            ))}
          </div>
        ) : (
          <EmptyState
            icon={<StarIcon className="size-5" />}
            title="No favorites yet"
            hint="Star a model in the library to pin it here for quick access."
            action={{ label: "Browse the library", onClick: () => onNavigate("models") }}
          />
        )}
      </section>
    </div>
  );
}

/** Bento hero (8 cols): chip identity + CPU / memory / OS stat tiles. */
function HardwareHero({
  profile,
  loading,
  onRefresh,
  modelsBytes,
}: {
  profile: HardwareProfile | null;
  loading: boolean;
  onRefresh: () => void;
  modelsBytes: number;
}) {
  if (loading && !profile) {
    return (
      <section className="card shimmer col-span-12 h-56 lg:col-span-8" aria-hidden />
    );
  }

  const chip = profile?.chip ?? profile?.model_name ?? "Your Mac";
  const cores = profile?.total_cores != null ? `${profile.total_cores}` : null;
  const coresSub =
    profile?.performance_cores != null && profile?.efficiency_cores != null
      ? `${profile.performance_cores}P + ${profile.efficiency_cores}E cores`
      : "cores";
  const unavailable = !profile || (profile.chip == null && profile.memory_bytes == null);
  // Real ratio only: installed model weights vs unified memory.
  const memFraction =
    profile?.memory_bytes != null && profile.memory_bytes > 0 && modelsBytes > 0
      ? modelsBytes / profile.memory_bytes
      : null;

  return (
    <section className="card col-span-12 flex flex-col gap-5 p-6 lg:col-span-8">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <span className="label-caps">Local hardware</span>
          <div className="mt-1.5 flex items-center gap-2.5">
            <ChipIcon className="size-5 shrink-0 text-accent-text" />
            <h3 className="truncate text-2xl font-semibold tracking-tight text-fg">{chip}</h3>
          </div>
          {profile?.apple_silicon && (
            <span className="mt-1.5 inline-flex items-center gap-1.5 text-[11px] text-fg-muted">
              <span className="size-1.5 rounded-full bg-ok" aria-hidden />
              Apple Silicon · unified memory
            </span>
          )}
        </div>
        <button
          type="button"
          onClick={onRefresh}
          aria-label="Refresh hardware profile"
          className="shrink-0 rounded-[var(--radius-control)] p-1.5 text-fg-subtle transition-colors duration-150 ease-out hover:bg-surface-raised hover:text-fg focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/45"
        >
          <RefreshIcon className={`size-4 ${loading ? "animate-spin" : ""}`} />
        </button>
      </div>

      {unavailable ? (
        <p className="text-sm text-fg-subtle">Hardware details unavailable.</p>
      ) : (
        <div className="mt-auto grid grid-cols-1 gap-3 sm:grid-cols-3">
          {cores && <StatTile label="CPU" value={cores} sub={coresSub} />}
          {profile.memory_bytes != null && (
            <StatTile
              label="Memory"
              value={formatBytes(profile.memory_bytes)}
              sub={modelsBytes > 0 ? `${formatBytes(modelsBytes)} in model weights` : "unified"}
              fraction={memFraction}
            />
          )}
          <StatTile
            label={profile.os_version ? "macOS" : "Arch"}
            value={profile.os_version ?? profile.arch}
            sub={profile.os_version ? profile.arch : undefined}
          />
        </div>
      )}
    </section>
  );
}

/** Bento side card (4 cols): installed models with quant + size, library figures footer. */
function ModelStatusCard({
  installed,
  stats,
  favorites,
  onNavigate,
}: {
  installed: LibraryModel[];
  stats: { installed: number; onDisk: number; families: number };
  favorites: number;
  onNavigate: (tab: Tab) => void;
}) {
  return (
    <section className="card col-span-12 flex flex-col p-6 lg:col-span-4">
      <span className="label-caps">Installed models</span>
      <div className="scrollbar-slim mt-3 flex-1 space-y-2 overflow-y-auto lg:max-h-44">
        {installed.length > 0 ? (
          installed.map((m) => (
            <div
              key={m.id}
              className="flex items-center justify-between gap-3 rounded-lg border border-white/8 bg-canvas px-3 py-2"
            >
              <div className="flex min-w-0 items-center gap-2.5">
                <span className="size-1.5 shrink-0 rounded-full bg-ok" aria-hidden />
                <div className="min-w-0">
                  <p className="data truncate text-sm font-medium text-fg">{m.name}</p>
                  {m.spec.quant && <p className="label-caps mt-0.5 text-[10px]">{m.spec.quant}</p>}
                </div>
              </div>
              {m.size_bytes != null && (
                <span className="mono-metric shrink-0 text-xs text-fg-muted">{formatBytes(m.size_bytes)}</span>
              )}
            </div>
          ))
        ) : (
          <p className="text-sm text-fg-subtle">
            Nothing installed yet.{" "}
            <button
              type="button"
              onClick={() => onNavigate("models")}
              className="cursor-pointer text-accent-text hover:underline"
            >
              Browse the library
            </button>
          </p>
        )}
      </div>
      <div className="mono-metric mt-4 flex items-center justify-between border-t border-white/8 pt-3 text-xs text-fg-muted">
        <span>{stats.installed} installed</span>
        <span>{stats.families} families</span>
        <span>{favorites} starred</span>
      </div>
    </section>
  );
}

/** Full-width bento footer: installed model weights as thin bars, scaled to the largest. */
function ModelSizesCard({ installed }: { installed: LibraryModel[] }) {
  const sized = installed.filter((m) => (m.size_bytes ?? 0) > 0);
  if (sized.length === 0) return null;
  const max = Math.max(...sized.map((m) => m.size_bytes ?? 0));

  return (
    <section className="card col-span-12 p-6">
      <span className="label-caps">Disk footprint</span>
      <div className="mt-4 space-y-3">
        {sized.map((m) => (
          <div key={m.id}>
            <div className="flex items-baseline justify-between gap-3">
              <span className="data truncate text-sm text-fg">{m.name}</span>
              <span className="mono-metric shrink-0 text-xs text-fg-muted">
                {formatBytes(m.size_bytes ?? 0)}
              </span>
            </div>
            <div className="mt-1.5 h-1 w-full overflow-hidden rounded-full bg-white/8">
              <div
                className="h-full rounded-full bg-accent"
                style={{ width: `${Math.max(2, Math.round(((m.size_bytes ?? 0) / max) * 100))}%` }}
              />
            </div>
          </div>
        ))}
      </div>
    </section>
  );
}

function EmptyState({
  icon,
  title,
  hint,
  action,
}: {
  icon: React.ReactNode;
  title: string;
  hint: string;
  action?: { label: string; onClick: () => void };
}) {
  return (
    <div className="flex flex-col items-center justify-center rounded-[var(--radius-card)] border border-dashed border-[var(--hairline)] px-6 py-14 text-center">
      <span className="flex size-12 items-center justify-center rounded-full bg-white/5 text-fg-subtle ring-1 ring-inset ring-white/10">
        {icon}
      </span>
      <p className="mt-4 font-medium text-fg">{title}</p>
      <p className="mt-1 max-w-xs text-sm text-fg-muted">{hint}</p>
      {action && (
        <Button variant="primary" className="mt-4" onClick={action.onClick}>
          {action.label}
        </Button>
      )}
    </div>
  );
}
