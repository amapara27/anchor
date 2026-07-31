import { useMemo } from "react";
import type { HardwareProfile, LibraryModel } from "../../types";
import { formatBytes } from "../../lib/format";
import { DEFAULT_CONTEXT } from "../../lib/fit";
import { hardwareHint, type HardwareHint } from "../../lib/hint";
import { Select, type SelectOption } from "./Select";

interface ModelMeta {
  installed: boolean;
  size: string | null;
  hint: HardwareHint | null;
}

/**
 * Model dropdown. Wraps `Select` with rows that carry what a native `<select>`
 * can never show: install state, on-disk size, and whether the model fits this
 * Mac's memory — the hint that makes the pick an informed one.
 */
export function ModelSelect({
  value,
  onChange,
  models,
  profile,
  disabled,
  disabledId,
  variant = "field",
  label,
  ariaLabel = "Model",
  className,
  placeholder = "Choose a model…",
}: {
  value: string;
  onChange: (id: string) => void;
  models: LibraryModel[];
  profile?: HardwareProfile | null;
  disabled?: boolean;
  /** Chosen in a paired slot — offered but not selectable here. */
  disabledId?: string;
  variant?: "field" | "pill";
  label?: string;
  ariaLabel?: string;
  className?: string;
  placeholder?: string;
}) {
  const options = useMemo<SelectOption[]>(
    () =>
      models.map((m) => {
        const meta: ModelMeta = {
          installed: m.status === "installed",
          size: m.size_bytes != null ? formatBytes(m.size_bytes) : null,
          hint: hardwareHint(
            {
              id: m.id,
              params_b: m.spec.params_b,
              quant: m.spec.quant,
              contextTokens: m.spec.context_tokens || DEFAULT_CONTEXT,
              arch: m.arch,
              sizeBytes: m.size_bytes,
            },
            profile,
          ),
        };
        return {
          value: m.id,
          label: m.name,
          group: m.status === "installed" ? "Installed" : "Available to download",
          disabled: m.id === disabledId,
          meta,
        };
      }),
    // Installed first so the group headings come out in a sensible order.
    [models, profile, disabledId],
  );

  const sorted = useMemo(
    () => [...options].sort((a, b) => Number(b.group === "Installed") - Number(a.group === "Installed")),
    [options],
  );

  return (
    <Select
      value={value}
      onChange={onChange}
      options={sorted}
      disabled={disabled}
      variant={variant}
      label={label}
      ariaLabel={ariaLabel}
      className={className}
      placeholder={placeholder}
      menuWidth={variant === "pill" ? 300 : "trigger"}
      renderValue={(o) => {
        const meta = o.meta as ModelMeta;
        return (
          <span className="flex min-w-0 items-center gap-2">
            <span className={`size-1.5 shrink-0 rounded-full ${meta.installed ? "bg-ok" : "bg-hair2"}`} />
            <span className="data truncate text-[12px] font-medium">{o.label}</span>
          </span>
        );
      }}
      renderOption={(o) => {
        const { installed, size, hint } = o.meta as ModelMeta;
        // A model that won't fit shows its shortfall instead of its size — the
        // row is 300px and the missing GB is the number that decides the pick.
        const showSize = size && hint?.tier !== "wont_fit";
        return (
          <span className="flex min-w-0 items-center gap-2" title={hint?.text}>
            <span className={`size-1.5 shrink-0 rounded-full ${installed ? "bg-ok" : "bg-hair2"}`} />
            <span className="data min-w-0 flex-1 truncate">{o.label}</span>
            {hint && hint.tier !== "unknown" && (
              <span className={`data shrink-0 text-[10px] ${hint.tone}`}>{hint.label.toLowerCase()}</span>
            )}
            {hint?.detail && <span className="data shrink-0 text-[10px] text-fg-muted">{hint.detail}</span>}
            {showSize && <span className="data shrink-0 text-[10px] text-fg-subtle">{size}</span>}
          </span>
        );
      }}
    />
  );
}
