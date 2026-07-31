import type { HardwareProfile, LibraryModel } from "../types";
import { formatBytes } from "../lib/format";
import { DEFAULT_CONTEXT } from "../lib/fit";
import { hardwareHint } from "../lib/hint";
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

/**
 * Labeled model dropdown for one comparison slot: the shared `ModelSelect`
 * (installed/available groups, per-row fit and size) plus a status line so the
 * user knows whether a pick will trigger a download.
 */
export function ModelPicker({ label, value, onChange, models, disabledId, disabled, profile }: ModelPickerProps) {
  const selected = models.find((m) => m.id === value);

  // Hardware hint for the selected model (only when a profile is supplied).
  const hint = selected
    ? hardwareHint(
        {
          id: selected.id,
          params_b: selected.spec.params_b,
          quant: selected.spec.quant,
          contextTokens: selected.spec.context_tokens || DEFAULT_CONTEXT,
          arch: selected.arch,
          sizeBytes: selected.size_bytes,
        },
        profile,
      )
    : null;

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

      {/* Hardware hint: fit tier + throughput (or the shortfall) on this Mac. */}
      {hint && hint.tier !== "unknown" && (
        <div className="mt-1 flex items-center gap-1.5 text-xs text-fg-subtle">
          <span className={`font-medium ${hint.tone}`}>{hint.label}</span>
          {hint.detail && (
            <>
              <span aria-hidden>·</span>
              <span className="data">
                {hint.detail}
                {hint.tps?.source === "measured" && <span className="text-ok"> measured</span>}
              </span>
            </>
          )}
        </div>
      )}
    </div>
  );
}
