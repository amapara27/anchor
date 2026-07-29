import type { HardwareProfile, LibraryModel, QuantId } from "../types";
import { formatBytes, formatTokSec } from "../lib/format";
import { DEFAULT_CONTEXT, estimateFit } from "../lib/fit";
import { resolveTokPerSec } from "../lib/tokps";
import { ChevronDownIcon, DownloadIcon } from "./icons";

interface ModelPickerProps {
  label: string;
  value: string;
  onChange: (id: string) => void;
  models: LibraryModel[];
  /** Model chosen in the other slot — disabled here so the two stay distinct. */
  disabledId?: string;
  disabled?: boolean;
  /** When set, show a fit + throughput hint for the selected model (the moat).
   *  Native `<select>` can't render per-row hints, so it targets the selection. */
  profile?: HardwareProfile | null;
}

/** Fit tier → short label + tone, for the selected-model hardware hint. */
const FIT_LABEL: Record<string, { text: string; tone: string } | undefined> = {
  ok: { text: "Fits", tone: "text-ok" },
  tight: { text: "Tight fit", tone: "text-warn" },
  wont_fit: { text: "Won't fit", tone: "text-danger" },
};

/**
 * Labeled model dropdown for one comparison slot. Reuses the `SelectChip` idiom
 * (appearance-none native select + our chevron) from `LibraryToolbar`, grouped
 * into Installed / Available, with a status line below so the user knows whether
 * a pick will trigger a download.
 */
export function ModelPicker({
  label,
  value,
  onChange,
  models,
  disabledId,
  disabled,
  profile,
}: ModelPickerProps) {
  const installed = models.filter((m) => m.status === "installed");
  const available = models.filter((m) => m.status === "available");
  const selected = models.find((m) => m.id === value);

  // Hardware hint for the selected model (only when a profile is supplied).
  const fit =
    profile && selected
      ? estimateFit(
          selected.spec.params_b,
          selected.spec.quant as QuantId,
          DEFAULT_CONTEXT,
          { memory_bytes: profile.memory_bytes },
          { arch: selected.arch, size_bytes: selected.size_bytes },
        )
      : null;
  const tps =
    profile && selected
      ? resolveTokPerSec(profile.chip, selected.id, selected.spec.params_b, selected.spec.quant as QuantId)
      : null;
  const fitLabel = fit ? FIT_LABEL[fit.tier] : undefined;

  return (
    <div className="min-w-0 flex-1">
      <label className="mb-1.5 block label-caps">
        {label}
      </label>
      <div className="relative">
        <select
          value={value}
          onChange={(e) => onChange(e.target.value)}
          disabled={disabled}
          aria-label={`${label} model`}
          className="w-full cursor-pointer appearance-none rounded-lg border border-white/8 bg-white/5 py-2.5 pl-3 pr-9 text-sm font-medium text-fg transition-colors hover:border-white/15 focus:border-accent/60 focus:outline-none focus:ring-2 focus:ring-accent/25 disabled:cursor-not-allowed disabled:opacity-50 [&>optgroup]:bg-surface [&>option]:bg-surface [&>option]:text-fg"
        >
          <option value="" disabled>
            Choose a model…
          </option>
          {installed.length > 0 && (
            <optgroup label="Installed">
              {installed.map((m) => (
                <option key={m.id} value={m.id} disabled={m.id === disabledId}>
                  {m.name}
                </option>
              ))}
            </optgroup>
          )}
          {available.length > 0 && (
            <optgroup label="Available to download">
              {available.map((m) => (
                <option key={m.id} value={m.id} disabled={m.id === disabledId}>
                  {m.name}
                </option>
              ))}
            </optgroup>
          )}
        </select>
        <ChevronDownIcon className="pointer-events-none absolute right-3 top-1/2 size-4 -translate-y-1/2 text-fg-subtle" />
      </div>

      {/* Install status — icon + text, never colour alone. */}
      <div className="mt-2 flex items-center gap-1.5 text-xs">
        {!selected ? (
          <span className="text-fg-subtle">No model selected</span>
        ) : selected.status === "installed" ? (
          <>
            <span className="size-1.5 shrink-0 rounded-full bg-ok" aria-hidden />
            <span className="font-medium text-ok">Installed</span>
          </>
        ) : (
          <>
            <DownloadIcon className="size-3.5 shrink-0 text-fg-muted" />
            <span className="text-fg-muted">
              Will download <span className="data">(~{formatBytes(selected.spec.download_bytes)})</span>
            </span>
          </>
        )}
      </div>

      {/* Hardware hint: fit tier + throughput on this Mac. */}
      {selected && fitLabel && (
        <div className="mt-1 flex items-center gap-1.5 text-xs text-fg-subtle">
          <span className={`font-medium ${fitLabel.tone}`}>{fitLabel.text}</span>
          {tps && (
            <>
              <span aria-hidden>·</span>
              <span className="data">
                ~{formatTokSec(tps.value)}
                {tps.source === "estimated" && <span className="text-fg-subtle"> est.</span>}
              </span>
            </>
          )}
        </div>
      )}
    </div>
  );
}
