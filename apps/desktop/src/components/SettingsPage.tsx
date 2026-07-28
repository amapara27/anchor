import { useMemo } from "react";
import type { HardwareProfile } from "../types";
import { useModels } from "../lib/useModels";
import { useHardwareProfile } from "../lib/useHardwareProfile";
import { useServerStatus } from "../lib/useServerStatus";
import { formatBytes } from "../lib/format";
import { PageHeader } from "./PageHeader";
import { StatTile } from "./ui/StatTile";
import { ChipIcon, RefreshIcon } from "./icons";

/** Settings: host hardware + live Ollama server status. */
export function SettingsPage() {
  const { models } = useModels();
  const { profile, loading: hwLoading, refresh: refreshHardware } = useHardwareProfile();

  const modelsBytes = useMemo(
    () => models.filter((m) => m.status === "installed").reduce((sum, m) => sum + (m.size_bytes ?? 0), 0),
    [models],
  );

  return (
    <div className="space-y-8">
      <PageHeader eyebrow="Settings" title="Settings" subtitle="Your hardware and the local inference server." />
      <HardwarePanel profile={profile} loading={hwLoading} onRefresh={refreshHardware} modelsBytes={modelsBytes} />
      <ServerPanel />
    </div>
  );
}

/** Chip identity + CPU / memory / OS stat tiles. Salvaged from the old Home hero. */
function HardwarePanel({
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
    return <section className="card shimmer h-56" aria-hidden />;
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
    <section className="card flex flex-col gap-5 p-6">
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
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-3">
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

/** Live Ollama server state. Status-only; ponytail: add start/stop when asked. */
function ServerPanel() {
  const { status, loading, refresh } = useServerStatus();
  const reachable = status?.reachable ?? false;

  return (
    <section className="card flex flex-col gap-4 p-6">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <span className="label-caps">Ollama server</span>
          <div className="mt-1.5 flex items-center gap-2">
            <span className={`size-2 rounded-full ${reachable ? "bg-ok" : "bg-fg-subtle"}`} aria-hidden />
            <h3 className="text-lg font-semibold tracking-tight text-fg">{reachable ? "Running" : "Stopped"}</h3>
          </div>
          <p className="mt-1.5 text-sm text-fg-muted">
            {reachable
              ? status?.managed
                ? "Started and managed by Anchor."
                : "Already running (started outside Anchor)."
              : "Not reachable. Anchor starts it on demand when you use a model."}
            {reachable && status?.version ? ` · v${status.version}` : ""}
          </p>
        </div>
        <button
          type="button"
          onClick={refresh}
          aria-label="Refresh server status"
          className="shrink-0 rounded-[var(--radius-control)] p-1.5 text-fg-subtle transition-colors duration-150 ease-out hover:bg-surface-raised hover:text-fg focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/45"
        >
          <RefreshIcon className={`size-4 ${loading ? "animate-spin" : ""}`} />
        </button>
      </div>
    </section>
  );
}
