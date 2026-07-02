import { useMemo } from "react";
import type { HardwareProfile, Tab } from "../types";
import { useModels } from "../lib/useModels";
import { useFavorites } from "../lib/useFavorites";
import { useHardwareProfile } from "../lib/useHardwareProfile";
import { formatBytes } from "../lib/format";
import { ModelCard } from "./ModelCard";
import { PageHeader } from "./PageHeader";
import { Figure } from "./ui/Figure";
import { SectionHeading } from "./ui/SectionHeading";
import { Button } from "./ui/Button";
import { ChipIcon, ClockIcon, RefreshIcon, StarIcon } from "./icons";

interface HomePageProps {
  onNavigate: (tab: Tab) => void;
}

/** Landing page: a hardware status strip, inline library figures, and favorites. */
export function HomePage({ onNavigate }: HomePageProps) {
  const { models, downloads, startDownload, cancelDownload } = useModels();
  const { isFavorite, toggleFavorite } = useFavorites();
  const { profile, loading: hwLoading, refresh: refreshHardware } = useHardwareProfile();
  const totalMemoryBytes = profile?.memory_bytes ?? null;

  const stats = useMemo(() => {
    const installed = models.filter((m) => m.status === "installed");
    const onDisk = installed.reduce((sum, m) => sum + (m.size_bytes ?? 0), 0);
    const families = new Set(installed.map((m) => m.family));
    return { installed: installed.length, onDisk, families: families.size };
  }, [models]);

  const favorites = useMemo(() => models.filter((m) => isFavorite(m.id)), [models, isFavorite]);

  return (
    <div className="space-y-10">
      <PageHeader eyebrow="Overview" title="Home" subtitle="Your local AI at a glance." />

      <HardwareStrip profile={profile} loading={hwLoading} onRefresh={refreshHardware} />

      {/* Library figures — boxless, separated by spacing not borders. */}
      <section className="grid grid-cols-2 gap-8 sm:grid-cols-4">
        <Figure label="Installed" value={stats.installed} />
        <Figure label="On disk" value={formatBytes(stats.onDisk)} />
        <Figure label="Families" value={stats.families} />
        <Figure label="Favorites" value={favorites.length} />
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

      <section className="space-y-4">
        <SectionHeading>Recent usage</SectionHeading>
        <EmptyState
          icon={<ClockIcon className="size-5" />}
          title="Usage tracking coming soon"
          hint="Once workflows run locally, your recent models and sessions will show up here."
        />
      </section>
    </div>
  );
}

/** Full-width host hardware band: chip name up front, specs as inline figures. */
function HardwareStrip({
  profile,
  loading,
  onRefresh,
}: {
  profile: HardwareProfile | null;
  loading: boolean;
  onRefresh: () => void;
}) {
  if (loading && !profile) {
    return (
      <section className="shimmer flex items-center gap-8 border-b border-[var(--hairline)] pb-8">
        <div className="h-8 w-56 rounded bg-white/8" />
        <div className="ml-auto h-8 w-64 rounded bg-white/8" />
      </section>
    );
  }

  const chip = profile?.chip ?? profile?.model_name ?? "Your Mac";
  const cores =
    profile?.total_cores != null
      ? `${profile.total_cores}-core` +
        (profile.performance_cores != null && profile.efficiency_cores != null
          ? ` ${profile.performance_cores}P+${profile.efficiency_cores}E`
          : "")
      : null;
  const unavailable = !profile || (profile.chip == null && profile.memory_bytes == null);

  return (
    <section className="flex flex-col gap-6 border-b border-[var(--hairline)] pb-8 lg:flex-row lg:items-center lg:justify-between">
      <div className="flex items-center gap-3.5">
        <span className="flex size-11 shrink-0 items-center justify-center rounded-[var(--radius-control)] bg-white/5 text-fg-muted ring-1 ring-inset ring-white/10">
          <ChipIcon className="size-5" />
        </span>
        <div className="min-w-0">
          <span className="text-xs uppercase tracking-wide text-fg-subtle">Your Mac</span>
          <p className="data truncate text-xl font-semibold tracking-tight text-fg">{chip}</p>
          {profile?.apple_silicon && (
            <span className="mt-1 inline-flex items-center gap-1.5 text-[11px] text-fg-muted">
              <span className="size-1.5 rounded-full bg-ok" aria-hidden />
              Apple Silicon · unified memory
            </span>
          )}
        </div>
      </div>

      {unavailable ? (
        <p className="text-sm text-fg-subtle">Hardware details unavailable.</p>
      ) : (
        <div className="flex items-center gap-8">
          {profile.memory_bytes != null && <Figure label="Memory" value={formatBytes(profile.memory_bytes)} />}
          {cores && <Figure label="CPU" value={cores} />}
          {profile.os_version && <Figure label="macOS" value={profile.os_version} />}
          <Figure label="Arch" value={profile.arch} />
          <button
            type="button"
            onClick={onRefresh}
            aria-label="Refresh hardware profile"
            className="shrink-0 rounded-[var(--radius-control)] p-1.5 text-fg-subtle transition-colors duration-150 ease-out hover:bg-surface-raised hover:text-fg focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/45"
          >
            <RefreshIcon className={`size-4 ${loading ? "animate-spin" : ""}`} />
          </button>
        </div>
      )}
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
