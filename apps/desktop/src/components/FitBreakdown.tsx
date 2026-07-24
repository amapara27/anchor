import { useState } from "react";
import type { ArchMeta, QuantId } from "../types";
import { estimateFit, fitContext } from "../lib/fit";
import { QUANTS } from "../lib/quant";
import { formatContext } from "../lib/format";
import { ChevronDownIcon } from "./icons";

const TIER_LABEL: Record<string, string> = {
  ok: "Comfortable fit",
  tight: "Tight fit",
  wont_fit: "Won't fit",
  unknown: "Fit unknown",
};
const TIER_CLASS: Record<string, string> = {
  ok: "text-ok",
  tight: "text-warn",
  wont_fit: "text-danger",
  unknown: "text-fg-subtle",
};

interface Props {
  params_b: number;
  /** Starting quant; coerced to a known QuantId (falls back to Q4_K_M). */
  quant: QuantId | string;
  contextTokens: number;
  memoryBytes?: number | null;
  /** GGUF architecture metadata; makes the memory math exact instead of bucketed. */
  arch?: ArchMeta | null;
  /** Real on-disk size, preferred over estimating weights from params × bpw. */
  sizeBytes?: number | null;
  defaultOpen?: boolean;
  /** Render just the panel (always open, no toggle) — for host-controlled rows. */
  headless?: boolean;
  className?: string;
}

/**
 * Expandable "why <tier>?" panel: the memory math behind a fit verdict, with
 * live context-length + quant controls.
 *
 * Given `arch`, the KV and compute-buffer figures come from the model's own
 * architecture metadata and are exact; without it they're bucketed from
 * parameter count. The header labels which, so a guess never reads as a fact.
 */
export function FitBreakdown({
  params_b,
  quant,
  contextTokens,
  memoryBytes,
  arch,
  sizeBytes,
  defaultOpen = false,
  headless = false,
  className = "",
}: Props) {
  const [open, setOpen] = useState(defaultOpen || headless);
  const [q, setQ] = useState<QuantId>((QUANTS.find((x) => x.id === quant)?.id ?? "Q4_K_M") as QuantId);
  const maxCtx = Math.max(contextTokens || 8192, 8192);
  // Open at the realistic default context (what Ollama loads), not the model's
  // advertised max — the slider still explores up to maxCtx.
  const [ctx, setCtx] = useState(fitContext(contextTokens));

  const fit = estimateFit(params_b, q, ctx, { memory_bytes: memoryBytes }, { arch, size_bytes: sizeBytes });
  const { weightsGB, kvCacheGB, computeBufferGB, osReserveGB, totalNeededGB, availableGB } =
    fit.breakdown;
  const denom = Math.max(availableGB, totalNeededGB, 0.001);
  const seg = (v: number) => `${Math.min(100, (v / denom) * 100)}%`;

  return (
    <div className={className}>
      {!headless && (
        <button
          type="button"
          onClick={() => setOpen((o) => !o)}
          aria-expanded={open}
          className="inline-flex items-center gap-1 text-xs font-medium text-fg-muted transition-colors duration-150 ease-out hover:text-fg"
        >
          <span className={TIER_CLASS[fit.tier]}>{TIER_LABEL[fit.tier]}</span>
          <span className="text-fg-subtle">
            {fit.kvSource === "metadata" ? "· from model metadata" : "· estimated"}
          </span>
          <ChevronDownIcon className={["size-3.5 transition-transform duration-150", open ? "rotate-180" : ""].join(" ")} />
        </button>
      )}

      {open && (
        <div className="mt-3 space-y-3">
          {/* Stacked memory bar vs available capacity */}
          <div className="relative h-2.5 w-full overflow-hidden rounded-full bg-white/5">
            <div className="flex h-full">
              <span className="bg-accent" style={{ width: seg(weightsGB) }} title="Weights" />
              <span className="bg-warn" style={{ width: seg(kvCacheGB) }} title="KV cache" />
              <span className="bg-warn/50" style={{ width: seg(computeBufferGB) }} title="Compute buffer" />
              <span className="bg-white/20" style={{ width: seg(osReserveGB) }} title="OS reserve" />
            </div>
            {availableGB > 0 && (
              <span
                className="absolute top-0 h-full w-px bg-fg"
                style={{ left: seg(availableGB) }}
                title={`Available: ${availableGB.toFixed(1)} GB`}
                aria-hidden
              />
            )}
          </div>

          <dl className="grid grid-cols-2 gap-x-4 gap-y-1 text-xs">
            <Row swatch="bg-accent" label="Weights" gb={weightsGB} />
            <Row swatch="bg-warn" label="KV cache" gb={kvCacheGB} />
            <Row swatch="bg-warn/50" label="Compute buffer" gb={computeBufferGB} />
            <Row swatch="bg-white/20" label="OS reserve" gb={osReserveGB} />
            <Row label="Needed" gb={totalNeededGB} strong />
            <Row label="Available" gb={availableGB} />
            <Row label="Headroom" gb={fit.headroomGB} strong className={fit.headroomGB < 0 ? "text-danger" : ""} />
          </dl>

          {/* Live controls */}
          <div className="space-y-2 pt-1">
            <label className="flex items-center justify-between text-xs text-fg-muted">
              <span>Context</span>
              <span className="data text-fg">{formatContext(ctx)} tok</span>
            </label>
            <input
              type="range"
              min={2048}
              max={maxCtx}
              step={2048}
              value={ctx}
              onChange={(e) => setCtx(Number(e.target.value))}
              aria-label="Context length"
              className="w-full accent-accent"
            />
            <div className="flex flex-wrap gap-1.5 pt-1">
              {QUANTS.map((meta) => (
                <button
                  key={meta.id}
                  type="button"
                  onClick={() => setQ(meta.id)}
                  title={meta.qualityNote}
                  aria-pressed={q === meta.id}
                  className={[
                    "data rounded-[var(--radius-control)] px-2 py-0.5 text-[11px] font-medium transition-colors duration-150 ease-out",
                    q === meta.id
                      ? "bg-accent/15 text-accent-text ring-1 ring-inset ring-accent/20"
                      : "text-fg-muted ring-1 ring-inset ring-white/10 hover:text-fg",
                  ].join(" ")}
                >
                  {meta.id}
                </button>
              ))}
            </div>
          </div>
          <p className="text-[11px] text-fg-subtle">All figures estimated — calibrated against measured runs when available.</p>
        </div>
      )}
    </div>
  );
}

function Row({
  swatch,
  label,
  gb,
  strong,
  className = "",
}: {
  swatch?: string;
  label: string;
  gb: number;
  strong?: boolean;
  className?: string;
}) {
  return (
    <div className={["flex items-center justify-between gap-2", className].join(" ")}>
      <span className="flex items-center gap-1.5 text-fg-muted">
        {swatch && <span className={["size-2 shrink-0 rounded-sm", swatch].join(" ")} aria-hidden />}
        {label}
      </span>
      <span className={["data tabular-nums", strong ? "text-fg" : "text-fg-muted"].join(" ")}>{gb.toFixed(1)} GB</span>
    </div>
  );
}
