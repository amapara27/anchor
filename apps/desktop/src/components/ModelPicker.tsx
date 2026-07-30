import type { HardwareProfile, LibraryModel, QuantId } from "../types";
import { formatBytes, formatTokSec } from "../lib/format";
import { DEFAULT_CONTEXT, estimateFit } from "../lib/fit";
import { resolveTokPerSec } from "../lib/tokps";
import { ModelSelect } from "./ui/ModelSelect";
import { DownloadIcon } from "./icons";

interface ModelPickerProps {
  label: string;
  value: string;
  onChange: (id: string) => void;
  models: LibraryModel[];
  /** Model chosen in the other slot — disabled here so the two stay distinct. */
  disabledId?: string;
  disabled?: boolean;
  /** When set, show a fit + throughput hint for the selected model (the moat). */
  profile?: HardwareProfile | null;
}

/** Fit tier → short label + tone, for the selected-model hardware hint. */
const FIT_LABEL: Record<string, { text: string; tone: string } | undefined> = {
  ok: { text: "Fits", tone: "text-ok" },
  tight: { text: "Tight fit", tone: "text-warn" },
  wont_fit: { text: "Won't fit", tone: "text-danger" },
};

/**
 * Labeled model dropdown for one comparison slot: the shared `ModelSelect`
 * (installed/available groups, per-row fit and size) plus a status line so the
 * user knows whether a pick will trigger a download.
 */
export function ModelPicker({ label, value, onChange, models, disabledId, disabled, profile }: ModelPickerProps) {
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
      <ModelSelect
        label={label}
        ariaLabel={`${label} model`}
        value={value}
        onChange={onChange}
        models={models}
        profile={profile}
        disabled={disabled}
        disabledId={disabledId}
      />

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
