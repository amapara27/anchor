import { useMemo } from "react";
import type { Tab } from "../types";
import { useModels } from "../lib/useModels";
import { useFavorites } from "../lib/useFavorites";
import { formatBytes } from "../lib/format";
import { ModelCard } from "./ModelCard";
import { BoxesIcon, ClockIcon, HardDriveIcon, LayersIcon, StarIcon } from "./icons";

interface HomePageProps {
  onNavigate: (tab: Tab) => void;
}

/** Landing page: at-a-glance stats, favorited models, and recent usage. */
export function HomePage({ onNavigate }: HomePageProps) {
  const { models, downloads, startDownload, cancelDownload } = useModels();
  const { isFavorite, toggleFavorite } = useFavorites();

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
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold tracking-tight text-slate-50">Home</h1>
        <p className="text-sm text-slate-400">Your local AI at a glance.</p>
      </header>

      <section className="grid grid-cols-2 gap-3 lg:grid-cols-4">
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
              />
            ))}
          </div>
        ) : (
          <EmptyState
            icon={<StarIcon className="size-6" />}
            title="No favorites yet"
            hint="Star a model in the library to pin it here for quick access."
          />
        )}
      </section>

      <section>
        <SectionHeading title="Recent usage" />
        <EmptyState
          icon={<ClockIcon className="size-6" />}
          title="Usage tracking coming soon"
          hint="Once workflows run locally, your recent models and sessions will show up here."
        />
      </section>
    </div>
  );
}

function StatCard({ icon, label, value }: { icon: React.ReactNode; label: string; value: string }) {
  return (
    <div className="rounded-xl border border-slate-800 bg-slate-900/50 p-4">
      <div className="flex items-center gap-1.5 text-slate-500">
        {icon}
        <span className="text-xs font-medium uppercase tracking-wide">{label}</span>
      </div>
      <p className="tabular mt-2 text-2xl font-semibold text-slate-100">{value}</p>
    </div>
  );
}

function SectionHeading({ title }: { title: string }) {
  return <h2 className="mb-3 text-sm font-semibold text-slate-200">{title}</h2>;
}

function EmptyState({ icon, title, hint }: { icon: React.ReactNode; title: string; hint: string }) {
  return (
    <div className="flex flex-col items-center justify-center rounded-xl border border-dashed border-slate-800 px-6 py-16 text-center text-slate-600">
      {icon}
      <p className="mt-3 text-slate-300">{title}</p>
      <p className="mt-1 max-w-xs text-sm text-slate-500">{hint}</p>
    </div>
  );
}
