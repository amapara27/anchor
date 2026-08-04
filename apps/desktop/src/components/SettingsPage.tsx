import { useMemo, useState } from "react";
import { DEFAULT_PRESET_ID, type HardwareProfile, type Preset } from "../types";
import { useModels } from "../lib/useModels";
import { usePresets } from "../lib/usePresets";
import { useHardwareProfile } from "../lib/useHardwareProfile";
import { useServerStatus } from "../lib/useServerStatus";
import { useTheme, type ThemePref } from "../lib/useTheme";
import { formatBytes, formatContext } from "../lib/format";
import { PageHeader, GhostButton } from "./PageHeader";
import { Toggle } from "./ui/Toggle";
import { Select } from "./ui/Select";
import { Meter } from "./ui/SegmentedBar";
import { ConfirmDialog } from "./ui/ConfirmDialog";
import { RefreshIcon, ShieldIcon } from "./icons";

type Section = "appearance" | "inference" | "hardware" | "privacy";

const SECTIONS: { key: Section; label: string }[] = [
  { key: "appearance", label: "Appearance" },
  { key: "inference", label: "Inference presets" },
  { key: "hardware", label: "Hardware & server" },
  { key: "privacy", label: "Privacy & sharing" },
];

const VERSION = "v0.1.0";
const PREFS_KEY = "anchor.prefs";

const SHORTCUTS = [
  { label: "Command palette", keys: "⌘K" },
  { label: "Send message", keys: "↩" },
  { label: "Newline in message", keys: "⇧↩" },
  { label: "Rename conversation", keys: "double-click" },
  { label: "Close dialog / dropdown", keys: "esc" },
  { label: "Toggle appearance", keys: "titlebar" },
];

/** Local-only preference rows. ponytail: localStorage until a settings table exists. */
const APPEARANCE_ROWS = [
  { id: "compact", label: "Compact density", detail: "Tighter rows in tables and the model library.", on: false },
  {
    id: "tokrate",
    label: "Show tokens per second in chat",
    detail: "Live throughput readout under each answer.",
    on: true,
  },
];

const PRIVACY_ROWS = [
  { id: "publish", label: "Publish benchmark runs", detail: "Chip, memory, model, quant and timings only.", on: false },
  {
    id: "note",
    label: "Include a written note with runs",
    detail: "Your review text is attached to published results.",
    on: false,
  },
  { id: "anon", label: "Anonymous mode", detail: "Publish as a chip class with no handle attached.", on: false },
];

function readPrefs(): Record<string, boolean> {
  try {
    return JSON.parse(localStorage.getItem(PREFS_KEY) ?? "{}") as Record<string, boolean>;
  } catch {
    return {};
  }
}

/** Settings: appearance, inference defaults, host hardware, and privacy. */
export function SettingsPage() {
  const [section, setSection] = useState<Section>("appearance");

  return (
    <>
      <PageHeader eyebrow="Manage" title="Settings" />

      <div className="grid grid-cols-[178px_minmax(0,1fr)] items-start gap-6">
        <nav className="sticky top-0 flex flex-col gap-0.5" aria-label="Settings sections">
          {SECTIONS.map((s) => {
            const active = s.key === section;
            return (
              <button
                key={s.key}
                type="button"
                onClick={() => setSection(s.key)}
                aria-current={active ? "true" : undefined}
                className={[
                  "flex h-8 cursor-pointer items-center rounded-lg px-2.5 text-left text-[13px] font-medium",
                  "transition-colors duration-150 ease-out focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/45",
                  active ? "bg-accent-soft text-accent-text" : "text-fg-muted hover:bg-inset hover:text-fg",
                ].join(" ")}
              >
                {s.label}
              </button>
            );
          })}
          <div className="card mt-3 flex flex-col gap-1.5 p-3">
            <span className="label-caps text-[9.5px]">Anchor</span>
            <span className="data text-xs text-fg">{VERSION}</span>
            <span className="text-[11px] leading-[1.45] text-fg-subtle">Pre-release build</span>
          </div>
        </nav>

        <div className="flex flex-col gap-3">
          {section === "appearance" && <AppearancePanel />}
          {section === "inference" && <InferencePanel />}
          {section === "hardware" && <HardwarePanel />}
          {section === "privacy" && <PrivacyPanel />}

          <section className="card flex flex-col gap-2.5 p-5">
            <span className="label-caps">Shortcuts</span>
            <div className="grid grid-cols-2 gap-x-6 gap-y-2">
              {SHORTCUTS.map((k) => (
                <span key={k.label} className="flex items-center gap-2.5 border-b border-hair py-1.5">
                  <span className="flex-1 text-[12.5px] text-fg-muted">{k.label}</span>
                  <kbd className="data rounded-[5px] border border-hair px-1.5 py-0.5 text-[11px] text-fg">
                    {k.keys}
                  </kbd>
                </span>
              ))}
            </div>
          </section>
        </div>
      </div>
    </>
  );
}

function SectionCard({ title, blurb, children }: { title: string; blurb?: string; children: React.ReactNode }) {
  return (
    <section className="card flex flex-col gap-3.5 p-5">
      <div className="flex flex-col gap-1">
        <h2 className="text-[15px] font-semibold text-fg">{title}</h2>
        {blurb && <p className="text-[12.5px] text-fg-muted">{blurb}</p>}
      </div>
      {children}
    </section>
  );
}

/** Toggle rows sharing one localStorage-backed preference map. */
function PrefRows({ rows }: { rows: typeof APPEARANCE_ROWS }) {
  const [prefs, setPrefs] = useState<Record<string, boolean>>(readPrefs);

  const set = (id: string, next: boolean) => {
    const updated = { ...prefs, [id]: next };
    setPrefs(updated);
    try {
      localStorage.setItem(PREFS_KEY, JSON.stringify(updated));
    } catch {
      // Storage unavailable — the choice stays in-memory for this session.
    }
  };

  return (
    <>
      {rows.map((r) => (
        <div key={r.id} className="flex items-center gap-3 border-t border-hair pt-3">
          <span className="flex min-w-0 flex-1 flex-col gap-0.5">
            <span className="text-[13px] text-fg">{r.label}</span>
            <span className="text-[11.5px] leading-[1.45] text-fg-subtle">{r.detail}</span>
          </span>
          <Toggle checked={prefs[r.id] ?? r.on} onChange={(next) => set(r.id, next)} label={r.label} />
        </div>
      ))}
    </>
  );
}

function AppearancePanel() {
  const { pref, setPref } = useTheme();

  const cards: { key: ThemePref; name: string; tag: string; preview: React.ReactNode }[] = [
    {
      key: "dark",
      name: "Graphite",
      tag: "violet",
      preview: <Swatch bg="#0A0A0B" border="rgba(255,255,255,.08)" bars={["#EAEAEC", "#3A3A42", "#8B7BE8"]} />,
    },
    {
      key: "light",
      name: "Cream",
      tag: "gold",
      preview: <Swatch bg="#F7F4ED" border="rgba(28,22,10,.12)" bars={["#1C1A15", "#CFC7B4", "#9A7317"]} />,
    },
    {
      key: "system",
      name: "Match system",
      tag: "auto",
      preview: (
        <span className="flex overflow-hidden rounded-lg border border-hair">
          <Swatch bg="#0A0A0B" border="transparent" bars={["#EAEAEC", "#8B7BE8"]} half />
          <Swatch bg="#F7F4ED" border="transparent" bars={["#1C1A15", "#9A7317"]} half />
        </span>
      ),
    },
  ];

  return (
    <SectionCard
      title="Appearance"
      blurb="Two moods, same structure. Dark leans graphite and violet; light leans cream and gold."
    >
      <div className="grid grid-cols-3 gap-2.5">
        {cards.map((c) => {
          const active = pref === c.key;
          return (
            <button
              key={c.key}
              type="button"
              onClick={() => setPref(c.key)}
              aria-pressed={active}
              className={[
                "flex cursor-pointer flex-col gap-2.5 rounded-[11px] border bg-inset p-3 text-left",
                "transition-transform duration-200 [transition-timing-function:var(--ease-out)] hover:-translate-y-0.5",
                "focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/45",
                active ? "border-accent-line" : "border-hair",
              ].join(" ")}
            >
              {c.preview}
              <span className="flex items-center gap-2 text-[12.5px] font-medium">
                <span className={active ? "text-accent-text" : "text-fg-muted"}>{c.name}</span>
                <span className="data ml-auto text-[10px] text-fg-subtle">{active ? "active" : c.tag}</span>
              </span>
            </button>
          );
        })}
      </div>
      <PrefRows rows={APPEARANCE_ROWS} />
    </SectionCard>
  );
}

function Swatch({ bg, border, bars, half }: { bg: string; border: string; bars: string[]; half?: boolean }) {
  const widths = [60, 85, 40];
  return (
    <span
      className={`flex flex-col gap-1.5 p-2.5 ${half ? "flex-1" : "rounded-lg"}`}
      style={{ background: bg, border: half ? undefined : `1px solid ${border}` }}
    >
      {bars.map((c, i) => (
        <span
          key={i}
          className="block h-[5px] rounded-full"
          style={{ background: c, width: `${widths[i] ?? 50}%` }}
        />
      ))}
    </span>
  );
}

/** Temperature a cleared field starts stepping from, matching Ollama's own default. */
const TEMP_START = 0.7;
/** Top of the temperature meter — above ~1.5 output is noise, not variety. */
const TEMP_MAX = 1.5;

const CTX_CHOICES = [2048, 4096, 8192, 16384, 32768, 65536, 131072];
const TOP_P_CHOICES = [0.7, 0.8, 0.9, 0.95, 1.0];

/** A `Select` option meaning "send nothing and let the model decide". */
const UNSET = { value: "", label: "Model default" };

/**
 * Presets: named bundles of {system prompt, temperature, context, top-p} that
 * `run_chat` reads straight out of SQLite.
 *
 * The app's inference defaults are the preset named Default — one table, one
 * resolution path, so there's no question of which of the two wins. A null field
 * is not zero: it means the option is omitted from the request entirely.
 */
function InferencePanel() {
  const { presets, loading, save, create, remove } = usePresets();
  const { models } = useModels();
  const [editingId, setEditingId] = useState(DEFAULT_PRESET_ID);
  const [pendingDelete, setPendingDelete] = useState<Preset | null>(null);

  // A deleted preset leaves the editor pointing at nothing — fall back.
  const preset = presets.find((p) => p.id === editingId) ?? presets[0] ?? null;
  const isDefault = preset?.id === DEFAULT_PRESET_ID;

  if (loading || !preset) return <section className="card shimmer h-72" aria-hidden />;

  const edit = (patch: Partial<Preset>) => save({ ...preset, ...patch });

  const temp = preset.temperature;
  const hint =
    temp == null
      ? "Unset — the model's own default is used."
      : temp <= 0.3
        ? "Deterministic — best for extraction, review and JSON output."
        : temp >= 1.0
          ? "Loose — more variety, more drift."
          : "Balanced — the default for general conversation.";

  return (
    <SectionCard
      title="Inference presets"
      blurb="A preset is applied to every turn in the conversations using it. Default covers everything else."
    >
      <div className="flex items-end gap-2.5">
        <Select
          label="Editing"
          className="flex-1"
          value={preset.id}
          onChange={setEditingId}
          options={presets.map((p) => ({ value: p.id, label: p.name }))}
        />
        <GhostButton className="h-8" onClick={() => setEditingId(create("New preset").id)}>
          New
        </GhostButton>
        <GhostButton
          tone="danger"
          className="h-8"
          disabled={isDefault}
          title={isDefault ? "The default preset can't be deleted" : undefined}
          onClick={() => setPendingDelete(preset)}
        >
          Delete
        </GhostButton>
      </div>

      {!isDefault && (
        <label className="flex flex-col gap-1.5">
          <span className="label-caps">Name</span>
          <input
            value={preset.name}
            onChange={(e) => edit({ name: e.target.value })}
            className="h-8 rounded-[var(--radius-control)] border border-hair bg-surface px-3 text-[12.5px] text-fg focus:border-accent/60 focus:outline-none focus:ring-2 focus:ring-accent/25"
          />
        </label>
      )}

      <label className="flex flex-col gap-1.5 border-t border-hair pt-3">
        <span className="label-caps">System prompt</span>
        <textarea
          value={preset.system ?? ""}
          onChange={(e) => edit({ system: e.target.value.trim() ? e.target.value : null })}
          rows={3}
          placeholder="e.g. You are a terse assistant. Answer in at most three sentences."
          className="scrollbar-slim resize-y rounded-[9px] border border-hair bg-surface px-3 py-2 text-[12.5px] leading-[1.6] text-fg placeholder:text-fg-subtle focus:border-accent/60 focus:outline-none focus:ring-2 focus:ring-accent/25"
        />
        <span className="text-[11.5px] text-fg-subtle">
          Sent as a system turn ahead of the history. It isn't stored in the conversation.
        </span>
      </label>

      <div className="flex flex-col gap-2 border-t border-hair pt-3">
        <div className="flex items-baseline gap-2.5">
          <span className="text-[13px] text-fg">Temperature</span>
          <span className="data ml-auto text-[13px] text-accent-text">
            {temp == null ? "default" : temp.toFixed(2)}
          </span>
          {temp != null && (
            <button
              type="button"
              onClick={() => edit({ temperature: null })}
              className="cursor-pointer text-[11px] text-fg-subtle underline-offset-2 hover:text-fg hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/45"
            >
              clear
            </button>
          )}
        </div>
        <div className="flex items-center gap-2.5">
          <Stepper
            label="Decrease temperature"
            onClick={() => edit({ temperature: stepTemp(temp, -0.05) })}
          >
            –
          </Stepper>
          <Meter fraction={(temp ?? 0) / TEMP_MAX} height={5} className="flex-1" />
          <Stepper
            label="Increase temperature"
            onClick={() => edit({ temperature: stepTemp(temp, 0.05) })}
          >
            +
          </Stepper>
        </div>
        <span className="text-[11.5px] text-fg-subtle">{hint}</span>
      </div>

      <div className="grid grid-cols-3 gap-2.5 border-t border-hair pt-3">
        <Select
          label="Context length"
          value={preset.num_ctx == null ? "" : String(preset.num_ctx)}
          onChange={(v) => edit({ num_ctx: v ? Number(v) : null })}
          options={[
            UNSET,
            ...CTX_CHOICES.map((n) => ({
              value: String(n),
              label: `${n.toLocaleString()} (${formatContext(n)})`,
            })),
          ]}
        />
        <Select
          label="Top-p"
          value={preset.top_p == null ? "" : String(preset.top_p)}
          onChange={(v) => edit({ top_p: v ? Number(v) : null })}
          options={[UNSET, ...TOP_P_CHOICES.map((v) => ({ value: String(v), label: v.toFixed(2) }))]}
        />
        <Select
          label="Intended model"
          value={preset.model ?? ""}
          onChange={(v) => edit({ model: v || null })}
          options={[
            { value: "", label: "Any model" },
            ...models
              .filter((m) => m.status === "installed")
              .map((m) => ({ value: m.id, label: m.name })),
          ]}
        />
      </div>

      <p className="rounded-[9px] border border-hair bg-inset px-3 py-2.5 text-[11.5px] leading-[1.5] text-fg-subtle">
        A context larger than the model supports is clamped by Ollama, not by Anchor — the residency readout
        shows what actually loaded. “Intended model” is a label; it doesn’t restrict where the preset can be used.
      </p>

      <ConfirmDialog
        open={pendingDelete != null}
        title="Delete preset?"
        body={
          pendingDelete
            ? `“${pendingDelete.name}” will be removed. Conversations using it fall back to Default; their messages are untouched.`
            : ""
        }
        confirmLabel="Delete"
        onConfirm={() => {
          if (pendingDelete) remove(pendingDelete.id);
          setEditingId(DEFAULT_PRESET_ID);
          setPendingDelete(null);
        }}
        onCancel={() => setPendingDelete(null)}
      />
    </SectionCard>
  );
}

/** Steps temperature, starting from Ollama's own default when it was unset. */
function stepTemp(current: number | null, delta: number): number {
  const from = current ?? TEMP_START;
  return Math.min(TEMP_MAX, Math.max(0, +(from + delta).toFixed(2)));
}

function Stepper({ children, onClick, label }: { children: React.ReactNode; onClick: () => void; label: string }) {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      className="flex size-[26px] cursor-pointer items-center justify-center rounded-[7px] border border-hair text-fg-muted transition-colors duration-150 ease-out hover:border-hair2 hover:text-fg focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/45 active:scale-95"
    >
      {children}
    </button>
  );
}

/** Chip identity, memory pressure, and live Ollama server state — all real. */
function HardwarePanel() {
  const { models } = useModels();
  const { profile, loading, refresh } = useHardwareProfile();
  const { status, loading: serverLoading, refresh: refreshServer } = useServerStatus();

  const modelsBytes = useMemo(
    () => models.filter((m) => m.status === "installed").reduce((sum, m) => sum + (m.size_bytes ?? 0), 0),
    [models],
  );

  if (loading && !profile) return <section className="card shimmer h-56" aria-hidden />;

  const reachable = status?.reachable ?? false;

  return (
    <SectionCard title={chipName(profile)}>
      <div className="-mt-2 flex items-center gap-3">
        {profile?.apple_silicon && (
          <span className="flex items-center gap-2 text-xs text-fg-muted">
            <span className="size-[5px] rounded-full bg-ok" aria-hidden />
            Apple Silicon · unified memory · profiled at first launch
          </span>
        )}
        <GhostButton onClick={refresh} className="ml-auto h-[30px] text-[12.5px]">
          <RefreshIcon className={`size-3.5 ${loading ? "animate-spin" : ""}`} />
          Re-profile
        </GhostButton>
      </div>

      <div className="grid grid-cols-4 gap-2.5">
        {profile?.total_cores != null && (
          <Tile
            label="CPU"
            value={String(profile.total_cores)}
            sub={
              profile.performance_cores != null && profile.efficiency_cores != null
                ? `${profile.performance_cores}P + ${profile.efficiency_cores}E cores`
                : "cores"
            }
          />
        )}
        {profile?.gpu_cores != null && <Tile label="GPU" value={String(profile.gpu_cores)} sub="cores" />}
        {profile?.memory_bytes != null && (
          <Tile
            label="Memory"
            value={formatBytes(profile.memory_bytes)}
            sub={modelsBytes > 0 ? `${formatBytes(modelsBytes)} in weights` : "unified"}
          />
        )}
        <Tile
          label={profile?.os_version ? "macOS" : "Arch"}
          value={profile?.os_version ?? profile?.arch ?? "—"}
          sub={profile?.os_version ? profile.arch : undefined}
        />
      </div>

      <div className="flex items-center gap-3 border-t border-hair pt-3.5">
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="flex items-center gap-2 text-[13.5px] font-semibold text-fg">
            Ollama server
            <span
              className={`data flex items-center gap-1.5 rounded-full border border-hair px-2 py-0.5 text-[10px] uppercase tracking-[0.06em] ${reachable ? "text-ok" : "text-fg-subtle"}`}
            >
              <span className="size-[5px] rounded-full bg-current" aria-hidden />
              {reachable ? "running" : "stopped"}
            </span>
          </span>
          <span className="data text-[11.5px] text-fg-muted">
            {reachable
              ? `127.0.0.1:11434${status?.version ? ` · v${status.version}` : ""} · ${status?.managed ? "started by Anchor" : "started outside Anchor"}`
              : "Not reachable. Anchor starts it on demand when you use a model."}
          </span>
        </div>
        <GhostButton onClick={refreshServer} className="h-[30px] shrink-0 text-[12.5px]">
          <RefreshIcon className={`size-3.5 ${serverLoading ? "animate-spin" : ""}`} />
          Refresh
        </GhostButton>
      </div>
    </SectionCard>
  );
}

function chipName(profile: HardwareProfile | null): string {
  return profile?.chip ?? profile?.model_name ?? "Your Mac";
}

function Tile({ label, value, sub }: { label: string; value: string; sub?: string }) {
  return (
    <span className="flex flex-col gap-1 rounded-[9px] border border-hair bg-inset p-3">
      <span className="label-caps text-[9.5px]">{label}</span>
      <span className="data text-[17px] text-fg">{value}</span>
      {sub && <span className="text-[11px] text-fg-subtle">{sub}</span>}
    </span>
  );
}

function PrivacyPanel() {
  return (
    <SectionCard
      title="Privacy & sharing"
      blurb="Inference is always local. Only benchmark numbers can leave this Mac, and only when you say so."
    >
      <div className="flex items-center gap-3 rounded-[var(--radius-card)] border border-accent-line bg-accent-soft px-3.5 py-3">
        <span className="flex size-[26px] shrink-0 items-center justify-center rounded-lg border border-accent-line">
          <ShieldIcon className="size-3.5 text-accent-text" />
        </span>
        <span className="flex flex-col gap-0.5">
          <span className="text-[13px] font-semibold text-accent-text">
            No prompt or output ever leaves this device
          </span>
          <span className="text-[11.5px] text-fg-muted">
            Chats and agent traces are stored in a local SQLite file you can delete.
          </span>
        </span>
      </div>
      <PrefRows rows={PRIVACY_ROWS} />
      <p className="border-t border-hair pt-3 text-[11.5px] leading-[1.5] text-fg-subtle">
        Publishing is not wired up yet — these preferences are stored locally and take effect once a results
        server exists.
      </p>
    </SectionCard>
  );
}
