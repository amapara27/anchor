import { useEffect, useRef, useState } from "react";
import { useResidency } from "../lib/useResidency";
import { formatBytes, formatContext } from "../lib/format";

/**
 * Always-on readout of what Ollama has resident right now, with an eject.
 *
 * The one question every local-AI user eventually asks — "is a model still
 * sitting in my RAM?" — answered without opening a terminal. Sizes and context
 * come from `/api/ps`, so this is what actually loaded, not what was requested:
 * Ollama clamps `num_ctx` to what the model and memory allow.
 */
export function ResidencyPill() {
  const { models, residentBytes, unload, unloadAll } = useResidency();
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  // Nothing loaded and nothing to show — collapse the popover so it can't hang
  // open over an empty list after the last model is evicted.
  useEffect(() => {
    if (models.length === 0) setOpen(false);
  }, [models.length]);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (e: PointerEvent) => {
      if (!ref.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const idle = models.length === 0;

  return (
    <div ref={ref} className="relative">
      <button
        type="button"
        disabled={idle}
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        aria-haspopup="dialog"
        title={idle ? "No models loaded in memory" : "Models resident in memory"}
        className={[
          "flex h-[26px] items-center gap-1.5 rounded-full border border-hair py-[3px] pl-[7px] pr-2.5",
          "transition-colors duration-150 ease-out focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/45",
          idle
            ? "cursor-default text-fg-subtle"
            : "cursor-pointer text-fg-muted hover:border-hair2 hover:text-fg",
        ].join(" ")}
      >
        <span
          className={`size-1.5 rounded-full ${idle ? "bg-fg-subtle" : "animate-pulse-dot bg-accent"}`}
          aria-hidden
        />
        <span className="data text-[10.5px]">
          {idle ? "0 loaded" : `${models.length} loaded · ${formatBytes(residentBytes)}`}
        </span>
      </button>

      {open && (
        <div
          role="dialog"
          aria-label="Models in memory"
          className="absolute right-0 top-[calc(100%+8px)] z-50 w-[288px] animate-fade-in rounded-[var(--radius-card)] border border-hair bg-surface p-1.5 shadow-(--shadow-overlay)"
        >
          <div className="flex items-center gap-2 px-2 pb-1.5 pt-1">
            <span className="label-caps">In memory</span>
            <button
              type="button"
              onClick={unloadAll}
              className="data ml-auto cursor-pointer text-[10.5px] text-fg-subtle underline-offset-2 hover:text-fg hover:underline focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/45"
            >
              unload all
            </button>
          </div>

          {models.map((m) => (
            <div
              key={m.name}
              className="flex items-center gap-2.5 rounded-[7px] px-2 py-1.5 transition-colors hover:bg-inset"
            >
              <span className="flex min-w-0 flex-1 flex-col gap-0.5">
                <span className="data truncate text-[12px] text-fg" title={m.name}>
                  {m.name}
                </span>
                <span className="data text-[10.5px] text-fg-subtle">
                  {m.size != null ? formatBytes(m.size) : "size unknown"}
                  {m.context_length != null && ` · ${formatContext(m.context_length)} ctx`}
                </span>
              </span>
              <button
                type="button"
                onClick={() => unload(m.name)}
                className="shrink-0 cursor-pointer rounded-[6px] border border-hair px-2 py-1 text-[10.5px] text-fg-muted transition-colors hover:border-hair2 hover:text-fg focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/45"
              >
                Unload
              </button>
            </div>
          ))}

          <p className="px-2 pb-1 pt-1.5 text-[10.5px] leading-[1.45] text-fg-subtle">
            Weights are evicted on their own after a few idle minutes. Unloading frees the memory now.
          </p>
        </div>
      )}
    </div>
  );
}
