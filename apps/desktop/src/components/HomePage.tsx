import { useMemo } from "react";
import type { HardwareProfile, Tab } from "../types";
import { useModels } from "../lib/useModels";
import { useFavorites } from "../lib/useFavorites";
import { useHardwareProfile } from "../lib/useHardwareProfile";
import { formatBytes } from "../lib/format";
import { ModelCard } from "./ModelCard";
import { PageHeader } from "./PageHeader";
import {
  BoxesIcon,
  ChipIcon,
  ClockIcon,
  HardDriveIcon,
  LayersIcon,
  MemoryIcon,
  RefreshIcon,
  StarIcon,
} from "./icons";

interface HomePageProps {
  onNavigate: (tab: Tab) => void;
}

/** Landing page: a bento dashboard of system + library stats, favorites, and usage. */
export function HomePage({ onNavigate }: HomePageProps) {
  const { models, downloads, startDownload, cancelDownload } = useModels();
  const { isFavorite, toggleFavorite } = useFavorites();
  const { profile, loading: hwLoading, refresh: refreshHardware } = useHardwareProfile();
  const totalMemoryBytes = profile?.memory_bytes ?? null;

  const stats = useMemo(() => {
    const installed = models.filter((m) => m.status === "installed");
    const onDisk = installed.reduce((sum, m) => sum + (m.size_bytes ?? 0), 0);
    const families = new Set(installed.map((m) => m.family));
    return {
      installed: installed.length,
      onDisk,
      families: families.size,
      catalog: models.length,
    };
  }, [models]);

  const favorites = useMemo(() => models.filter((m) => isFavorite(m.id)), [models, isFavorite]);

  return (
    <div className="space-y-8">
      <PageHeader eyebrow="Overview" title="Home" subtitle="Your local AI at a glance." />

      {/* Bento: a 2×2 hardware hero anchors the grid; four stat tiles fill the rest. */}
      <section className="grid grid-cols-2 gap-3 lg:grid-cols-4 lg:auto-rows-[132px]">
        <HardwareHero profile={profile} loading={hwLoading} onRefresh={refreshHardware} />
        <StatCard icon={<BoxesIcon className="size-4" />} label="Installed models" value={String(stats.installed)} />
        <StatCard icon={<HardDriveIcon className="size-4" />} label="On disk" value={formatBytes(stats.onDisk)} />
        <StatCard icon={<LayersIcon className="size-4" />} label="Families" value={String(stats.families)} />
        <StatCard icon={<StarIcon className="size-4" />} label="Favorites" value={String(favorites.length)} />
      </section>

      <section>
        <SectionHeading title="Favorite models" />
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

      <section>
        <SectionHeading title="Recent usage" />
        <EmptyState
          icon={<ClockIcon className="size-5" />}
          title="Usage tracking coming soon"
          hint="Once workflows run locally, your recent models and sessions will show up here."
        />
      </section>
    </div>
  );
}

/** "Your Mac" hero tile: the host hardware profile, made prominent (bento 2×2). */
function HardwareHero({
  profile,
  loading,
  onRefresh,
}: {
  profile: HardwareProfile | null;
  loading: boolean;
  onRefresh: () => void;
}) {
  const base = "card relative col-span-2 overflow-hidden p-5 lg:col-span-2 lg:row-span-2";

  // First-ever profiling can take a beat (a subprocess); show a placeholder.
  if (loading && !profile) {
    return (
      <div className={`${base} shimmer`}>
        <div className="h-4 w-28 rounded bg-white/8" />
        <div className="mt-3 h-7 w-48 rounded bg-white/8" />
        <div className="mt-6 grid grid-cols-2 gap-2">
          {Array.from({ length: 4 }).map((_, i) => (
            <div key={i} className="h-14 rounded-lg bg-white/5" />
          ))}
        </div>
      </div>
    );
  }

  const chip = profile?.chip ?? profile?.model_name ?? "Your Mac";
  const cores =
    profile?.total_cores != null
      ? `${profile.total_cores}-core` +
        (profile.performance_cores != null && profile.efficiency_cores != null
          ? ` · ${profile.performance_cores}P+${profile.efficiency_cores}E`
          : "")
      : null;
  const unavailable = !profile || (profile.chip == null && profile.memory_bytes == null);

  return (
    <div className={base}>
      <div className="relative flex h-full flex-col">
        <div className="flex items-start justify-between gap-3">
          <div className="flex min-w-0 items-start gap-3.5">
            <span className="flex size-11 shrink-0 items-center justify-center rounded-xl bg-white/5 text-fg-muted ring-1 ring-inset ring-white/10">
              <ChipIcon className="size-5" />
            </span>
            <div className="min-w-0">
              <span className="text-[11px] font-semibold uppercase tracking-[0.18em] text-fg-subtle">Your Mac</span>
              <p className="mt-0.5 truncate text-xl font-semibold tracking-tight text-fg">{chip}</p>
              {profile?.model_name && profile?.chip && (
                <p className="truncate text-xs text-fg-muted">{profile.model_name}</p>
              )}
            </div>
          </div>
          <button
            type="button"
            onClick={onRefresh}
            aria-label="Refresh hardware profile"
            className="-mr-1 shrink-0 cursor-pointer rounded-lg p-1.5 text-fg-subtle transition-colors hover:bg-white/6 hover:text-fg focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/45 active:scale-[0.96]"
          >
            <RefreshIcon className={`size-4 ${loading ? "animate-spin" : ""}`} />
          </button>
        </div>

        {unavailable ? (
          <p className="relative mt-4 text-sm text-fg-subtle">Hardware details unavailable.</p>
        ) : (
          <>
            <div className="mt-auto grid grid-cols-2 gap-2 pt-5">
              {profile.memory_bytes != null && (
                <HeroStat icon={<MemoryIcon className="size-4" />} label="Memory" value={formatBytes(profile.memory_bytes)} />
              )}
              {cores && <HeroStat icon={<ChipIcon className="size-4" />} label="CPU" value={cores} />}
              {profile.os_version && (
                <HeroStat icon={<HardDriveIcon className="size-4" />} label="macOS" value={profile.os_version} />
              )}
              <HeroStat icon={<LayersIcon className="size-4" />} label="Arch" value={profile.arch} />
            </div>
            {profile.apple_silicon && (
              <span className="mt-3 inline-flex w-fit items-center gap-1.5 rounded-full bg-white/5 px-2.5 py-0.5 text-[11px] font-medium text-fg-muted ring-1 ring-inset ring-white/10">
                <span className="size-1.5 rounded-full bg-ok" aria-hidden />
                Apple Silicon · unified memory
              </span>
            )}
          </>
        )}
      </div>
    </div>
  );
}

/** One spec inside the hardware hero. */
function HeroStat({ icon, label, value }: { icon: React.ReactNode; label: string; value: string }) {
  return (
    <div className="rounded-lg bg-white/5 px-3 py-2 ring-1 ring-inset ring-white/10">
      <div className="flex items-center gap-1.5 text-fg-subtle">
        {icon}
        <span className="text-[11px] uppercase tracking-wide">{label}</span>
      </div>
      <p className="data mt-1 truncate text-sm text-fg">{value}</p>
    </div>
  );
}

function StatCard({ icon, label, value }: { icon: React.ReactNode; label: string; value: string }) {
  return (
    <div className="card card-interactive flex flex-col justify-between p-4">
      <div className="flex items-center gap-2.5">
        <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-white/5 text-fg-muted ring-1 ring-inset ring-white/10">
          {icon}
        </span>
        <span className="text-xs font-medium uppercase tracking-wide text-fg-subtle">{label}</span>
      </div>
      <p className="data mt-3 text-3xl font-semibold tracking-tight text-fg">{value}</p>
    </div>
  );
}

function SectionHeading({ title }: { title: string }) {
  return (
    <h2 className="mb-3 flex items-center gap-2 text-sm font-semibold text-fg">
      {title}
      <span className="h-px flex-1 bg-white/8" aria-hidden />
    </h2>
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
    <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-white/10 bg-white/[0.015] px-6 py-14 text-center">
      <span className="flex size-12 items-center justify-center rounded-full bg-white/5 text-fg-subtle ring-1 ring-inset ring-white/10">
        {icon}
      </span>
      <p className="mt-4 font-medium text-fg">{title}</p>
      <p className="mt-1 max-w-xs text-sm text-fg-muted">{hint}</p>
      {action && (
        <button
          type="button"
          onClick={action.onClick}
          className="mt-4 cursor-pointer rounded-lg bg-accent px-3.5 py-1.5 text-xs font-semibold text-accent-fg transition-colors hover:bg-accent/90 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/50"
        >
          {action.label}
        </button>
      )}
    </div>
  );
}
