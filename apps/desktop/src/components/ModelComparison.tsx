import { useEffect, useState } from "react";
import { useModels } from "../lib/useModels";
import { useComparison } from "../lib/useComparison";
import { formatTokSec, tokensPerSecond } from "../lib/format";
import { PageHeader } from "./PageHeader";
import { ModelPicker } from "./ModelPicker";
import { ComparisonPane } from "./ComparisonPane";
import { PlayIcon } from "./icons";

/** Duration of the simultaneous typewriter reveal, ms. */
const REVEAL_MS = 1400;

export function ModelComparison() {
  const { models, loading } = useModels();
  const { a, b, running, revealed, run } = useComparison();

  const [modelA, setModelA] = useState("");
  const [modelB, setModelB] = useState("");
  const [prompt, setPrompt] = useState("");

  // Shared 0→1 reveal clock — both panes type out and finish together.
  const [fraction, setFraction] = useState(0);
  useEffect(() => {
    if (!revealed) {
      setFraction(0);
      return;
    }
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) {
      setFraction(1);
      return;
    }
    let raf = 0;
    const start = performance.now();
    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / REVEAL_MS);
      setFraction(t);
      if (t < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [revealed]);

  const distinct = modelA !== "" && modelB !== "" && modelA !== modelB;
  const canRun = distinct && prompt.trim().length > 0 && !running;
  const hasRun = a.phase !== "idle" || b.phase !== "idle";

  const aModel = models.find((m) => m.id === modelA);
  const bModel = models.find((m) => m.id === modelB);

  // Throughput comparison, only once both finished with real stats.
  const aTok = tokensPerSecond(a.stats);
  const bTok = tokensPerSecond(b.stats);
  const bothDone = a.phase === "done" && b.phase === "done" && aTok != null && bTok != null;
  const fastest: "a" | "b" | null = bothDone ? (aTok! >= bTok! ? "a" : "b") : null;

  return (
    <div className="flex flex-col gap-6">
      <PageHeader
        eyebrow="Compare"
        title="Model Comparison"
        subtitle="Run one prompt through two local models, side by side."
      />

      {/* Setup */}
      <div className="card p-5">
        <div className="flex flex-col items-stretch gap-3 lg:flex-row lg:items-end">
          <ModelPicker
            label="Model A"
            value={modelA}
            onChange={setModelA}
            models={models}
            disabledId={modelB}
            disabled={running || loading}
          />
          <div className="flex shrink-0 items-center justify-center pb-7 lg:pb-9">
            <span className="data flex size-8 items-center justify-center rounded-full bg-white/5 text-xs font-semibold text-fg-muted ring-1 ring-white/10">
              VS
            </span>
          </div>
          <ModelPicker
            label="Model B"
            value={modelB}
            onChange={setModelB}
            models={models}
            disabledId={modelA}
            disabled={running || loading}
          />
        </div>

        <div className="mt-4">
          <label
            htmlFor="comparison-prompt"
            className="mb-1.5 block text-[11px] font-semibold uppercase tracking-[0.18em] text-fg-subtle"
          >
            Prompt
          </label>
          <textarea
            id="comparison-prompt"
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            disabled={running}
            rows={3}
            placeholder="Ask both models the same thing…"
            className="scrollbar-slim w-full resize-y rounded-lg border border-white/8 bg-white/5 px-3 py-2.5 text-sm text-fg transition-colors placeholder:text-fg-subtle focus:border-accent/60 focus:outline-none focus:ring-2 focus:ring-accent/25 disabled:opacity-60"
          />
        </div>

        <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
          <p className="text-xs text-fg-subtle">
            Models that aren’t installed will be downloaded first. They run one at a time to fit in
            memory.
          </p>
          <button
            type="button"
            onClick={() => run(modelA, modelB, prompt)}
            disabled={!canRun}
            className="inline-flex shrink-0 cursor-pointer items-center gap-2 rounded-lg bg-accent px-4 py-2 text-sm font-semibold text-accent-fg transition-colors hover:bg-accent/90 focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/50 disabled:cursor-not-allowed disabled:opacity-40 disabled:hover:bg-accent"
          >
            {running ? (
              <>
                <Spinner /> Comparing…
              </>
            ) : (
              <>
                <PlayIcon className="size-4" /> Run comparison
              </>
            )}
          </button>
        </div>
      </div>

      {/* Results */}
      {hasRun && (
        <div className="flex flex-col gap-4">
          <div className="grid gap-4 lg:grid-cols-2">
            <ComparisonPane
              slotLabel="A"
              model={aModel}
              state={a}
              revealed={revealed}
              fraction={fraction}
              fastest={fastest === "a"}
            />
            <ComparisonPane
              slotLabel="B"
              model={bModel}
              state={b}
              revealed={revealed}
              fraction={fraction}
              fastest={fastest === "b"}
            />
          </div>

          {bothDone && fraction >= 1 && (
            <ThroughputBar
              aName={aModel?.name ?? "Model A"}
              bName={bModel?.name ?? "Model B"}
              aTok={aTok!}
              bTok={bTok!}
            />
          )}
        </div>
      )}
    </div>
  );
}

/** Side-by-side tok/sec bars scaled to the faster model. */
function ThroughputBar({
  aName,
  bName,
  aTok,
  bTok,
}: {
  aName: string;
  bName: string;
  aTok: number;
  bTok: number;
}) {
  const max = Math.max(aTok, bTok) || 1;
  return (
    <div className="card p-5">
      <div className="text-[11px] font-semibold uppercase tracking-[0.18em] text-fg-subtle">
        Throughput comparison
      </div>
      <div className="mt-3 space-y-3">
        {[
          { name: aName, tok: aTok, lead: aTok >= bTok },
          { name: bName, tok: bTok, lead: bTok > aTok },
        ].map((row) => (
          <div key={row.name}>
            <div className="mb-1 flex items-center justify-between text-xs">
              <span className="truncate font-medium text-fg">{row.name}</span>
              <span className="data text-fg-muted">{formatTokSec(row.tok)}</span>
            </div>
            <div className="h-2 overflow-hidden rounded-full bg-white/8">
              <div
                className={[
                  "h-full rounded-full transition-[width] duration-500 [transition-timing-function:var(--ease-out)]",
                  row.lead ? "bg-accent" : "bg-white/20",
                ].join(" ")}
                style={{ width: `${(row.tok / max) * 100}%` }}
              />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function Spinner() {
  return (
    <span
      className="size-4 animate-spin rounded-full border-2 border-white/30 border-t-white"
      aria-hidden
    />
  );
}
