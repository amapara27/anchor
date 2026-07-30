import { useMemo } from "react";
import type { HardwareProfile, LibraryModel, QuantId } from "../../types";
import { formatBytes } from "../../lib/format";
import { DEFAULT_CONTEXT, estimateFit } from "../../lib/fit";
import { Select, type SelectOption } from "./Select";

/** Fit tier → dot colour + short label, shared by the row and the trigger. */
const FIT: Record<string, { tone: string; text: string }> = {
  ok: { tone: "text-ok", text: "fits" },
  tight: { tone: "text-warn", text: "tight" },
  wont_fit: { tone: "text-danger", text: "won't fit" },
};

interface ModelMeta {
  installed: boolean;
  size: string | null;
  fit: { tone: string; text: string } | null;
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
}) {
  const options = useMemo<SelectOption[]>(
    () =>
      models.map((m) => {
        const fit =
          profile?.memory_bytes != null
            ? estimateFit(
                m.spec.params_b,
                m.spec.quant as QuantId,
                DEFAULT_CONTEXT,
                { memory_bytes: profile.memory_bytes },
                { arch: m.arch, size_bytes: m.size_bytes },
              )
            : null;
        const meta: ModelMeta = {
          installed: m.status === "installed",
          size: m.size_bytes != null ? formatBytes(m.size_bytes) : null,
          fit: fit ? (FIT[fit.tier] ?? null) : null,
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
      placeholder="Choose a model…"
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
        const meta = o.meta as ModelMeta;
        return (
          <span className="flex min-w-0 items-center gap-2">
            <span className={`size-1.5 shrink-0 rounded-full ${meta.installed ? "bg-ok" : "bg-hair2"}`} />
            <span className="data min-w-0 flex-1 truncate">{o.label}</span>
            {meta.fit && <span className={`data shrink-0 text-[10px] ${meta.fit.tone}`}>{meta.fit.text}</span>}
            {meta.size && <span className="data shrink-0 text-[10px] text-fg-subtle">{meta.size}</span>}
          </span>
        );
      }}
    />
  );
}
