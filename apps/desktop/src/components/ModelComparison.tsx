import { useEffect, useRef, useState } from "react";
import { useModels } from "../lib/useModels";
import { useComparison } from "../lib/useComparison";
import { useHardwareProfile } from "../lib/useHardwareProfile";
import { formatBytes, formatTokSec, tokensPerSecond } from "../lib/format";
import { recordUse } from "../lib/lastUsed";
import { exportComparison } from "../lib/exportImage";
import { ModelPicker } from "./ModelPicker";
import { ComparisonPane } from "./ComparisonPane";
import { Button } from "./ui/Button";
import { PlayIcon } from "./icons";

export function ModelComparison({onBusy}: {onBusy?: (busy: boolean) => void}) {
  const { models, loading } = useModels();
  const { profile } = useHardwareProfile();
  const { a, b, running, run, stop } = useComparison();

  const [modelA, setModelA] = useState("");
  const [modelB, setModelB] = useState("");
  const [prompt, setPrompt] = useState("");

  const fraction = 1;
  useEffect(() => { onBusy?.(running); }, [running, onBusy]);

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

  const chip = profile?.chip ?? null;
  const hardware = [chip ?? profile?.model_name, profile?.memory_bytes ? formatBytes(profile.memory_bytes) : null]
    .filter(Boolean)
    .join(" · ");

  // Record use once per completed comparison.
  const saved = useRef(false);
  useEffect(() => {
    if (!bothDone) {
      saved.current = false;
      return;
    }
    if (saved.current) return;
    saved.current = true;
    recordUse(modelA); // feeds Disk Usage's last-used column
    recordUse(modelB);
  }, [bothDone, modelA, modelB, chip, aTok, bTok, prompt, aModel, bModel]);

  const handleExport = () => {
    if (!bothDone) return;
    exportComparison({
      aName: aModel?.name ?? "Model A",
      bName: bModel?.name ?? "Model B",
      aOutput: a.response ?? "",
      bOutput: b.response ?? "",
      aTok: aTok!,
      bTok: bTok!,
      hardware,
    });
  };

  return (
    <div className="flex flex-col gap-6">
      {/* Setup */}
      <div className="comparison-setup">
        <div className="flex flex-col items-stretch gap-4 lg:flex-row lg:items-start">
          <ModelPicker
            label="Model A"
            value={modelA}
            onChange={setModelA}
            models={models}
            disabledId={modelB}
            disabled={running || loading}
          />
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
            className="mb-1.5 block label-caps"
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
            className="scrollbar-slim w-full resize-y rounded-lg border border-hair bg-inset px-3 py-2.5 text-[13px] text-fg transition-colors placeholder:text-fg-subtle hover:border-hair2 focus:border-hair2 focus:outline-none focus:ring-2 focus:ring-accent-line disabled:opacity-60"
          />
        </div>

        <div className="mt-4 flex flex-wrap items-center justify-between gap-3">
          <p className="text-xs text-fg-subtle">
            Models that aren’t installed will be downloaded first. They run one at a time to fit in
            memory.
          </p>
          {running && <Button variant="ghost" onClick={stop}>Stop comparison</Button>}
          <Button variant="primary" onClick={() => run(modelA, modelB, prompt)} disabled={!canRun}>
            {running ? (
              <>
                <Spinner /> Comparing…
              </>
            ) : (
              <>
                <PlayIcon className="size-4" /> Run comparison
              </>
            )}
          </Button>
        </div>
      </div>

      {/* Results */}
      {hasRun && (
        <div className="flex flex-col gap-4">
          <div className="flex min-h-8 items-center justify-between">
            <h3 className="text-[15px] font-semibold tracking-tight">Results</h3>
            {bothDone && fraction >= 1 && (
              <Button variant="ghost" onClick={handleExport}>
                Export result
              </Button>
            )}
          </div>
          <div className="grid gap-4 lg:grid-cols-2">
            <ComparisonPane
              slotLabel="A"
              model={aModel}
              state={a}
              revealed={true}
              fraction={fraction}
              fastest={fastest === "a"}
            />
            <ComparisonPane
              slotLabel="B"
              model={bModel}
              state={b}
              revealed={true}
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
    <div className="comparison-setup">
      <h3 className="text-[13px] font-medium text-fg">Throughput</h3>
      <div className="mt-3 space-y-3">
        {[
          { name: aName, tok: aTok, lead: aTok >= bTok },
          { name: bName, tok: bTok, lead: bTok > aTok },
        ].map((row) => (
          <div key={row.name}>
            <div className="mb-1 flex items-center justify-between text-xs">
              <span className="data truncate font-medium text-fg">{row.name}</span>
              <span className="data text-fg-muted">{formatTokSec(row.tok)}</span>
            </div>
            <div className="h-1.5 overflow-hidden rounded-[2px] bg-raised">
              <div
                className={[
                  "h-full rounded-[2px] transition-[width] duration-500 [transition-timing-function:var(--ease-out)]",
                  row.lead ? "bg-accent" : "bg-hair2",
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
      className="size-4 animate-spin rounded-full border-2 border-hair2 border-t-current"
      aria-hidden
    />
  );
}
