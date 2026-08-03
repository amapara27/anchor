import { useEffect, useState } from "react";
import { openUrl } from "@tauri-apps/plugin-opener";
import { useModels } from "../lib/useModels";
import { useResearch, type ResearchState } from "../lib/useResearch";
import { formatTokSec, tokensPerSecond } from "../lib/format";
import type { ResearchDepth, ResearchFormat } from "../types";
import { AgentHeader, Field, INPUT_CLASS, PhaseStepper, Spinner } from "../agents/AgentShell";
import { RESEARCH_PHASES } from "../agents/research-assistant/phases";
import { ModelPicker } from "./ModelPicker";
import { Select } from "./ui/Select";
import { Button } from "./ui/Button";
import { Chip } from "./ui/Chip";
import { ChevronDownIcon, SearchIcon } from "./icons";

/** localStorage key for the user's Tavily API key. */
const API_KEY_STORAGE = "anchor.tavilyApiKey";
/** Suggested default — a solid, widely-installed general research model. */
const DEFAULT_MODEL = "llama3.1:8b";

const DEPTHS: { value: ResearchDepth; label: string }[] = [
  { value: "brief", label: "Brief" },
  { value: "standard", label: "Standard" },
  { value: "deep", label: "Deep" },
];
const FORMATS: { value: ResearchFormat; label: string }[] = [
  { value: "report", label: "Report" },
  { value: "outline", label: "Outline" },
  { value: "qa", label: "Q&A" },
];

/**
 * The Research Assistant agent view: pick a model, enter a focus, tune the
 * knobs, and stream a cited web-research brief. Launched in place from the
 * Agents page (`onBack` returns to it, which also refreshes the run history —
 * `useResearch` files every settled run).
 */
export function ResearchAssistant({ onBack }: { onBack: () => void }) {
  const { models, loading } = useModels();
  const { state, running, run, reset } = useResearch();

  const [model, setModel] = useState("");
  const [focus, setFocus] = useState("");
  const [depth, setDepth] = useState<ResearchDepth>("standard");
  const [format, setFormat] = useState<ResearchFormat>("report");
  const [audience, setAudience] = useState("");
  const [systemOverride, setSystemOverride] = useState("");
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [apiKey, setApiKey] = useState(() => localStorage.getItem(API_KEY_STORAGE) ?? "");

  // Default the model once the library loads: prefer the suggested general
  // model, else the first installed one.
  useEffect(() => {
    if (model || models.length === 0) return;
    const suggested = models.find((m) => m.id === DEFAULT_MODEL);
    setModel(suggested?.id ?? models.find((m) => m.status === "installed")?.id ?? "");
  }, [models, model]);

  // Persist the Tavily key locally — the user's own key on a single-user desktop
  // app. ponytail: localStorage over the Tauri keychain; upgrade if it ever syncs.
  useEffect(() => {
    if (apiKey) localStorage.setItem(API_KEY_STORAGE, apiKey);
  }, [apiKey]);

  const canRun =
    model !== "" && focus.trim().length > 0 && apiKey.trim().length > 0 && !running;
  const hasRun = state.phase !== "idle";
  const tok = tokensPerSecond(state.stats);

  const handleRun = () =>
    run({
      model,
      focus: focus.trim(),
      depth,
      format,
      audience: audience.trim() || undefined,
      system_override: systemOverride.trim() || undefined,
      api_key: apiKey.trim() || undefined,
    });

  return (
    <div className="flex flex-col gap-6">
      <AgentHeader
        title="Research Assistant"
        subtitle="Searches the web, reads sources, and synthesizes a cited brief on any topic."
        onBack={onBack}
        onReset={reset}
        resetLabel="New research"
        running={running}
        showReset={hasRun}
      />

      {/* Setup */}
      <div className="card flex flex-col gap-4 p-5">
        <ModelPicker
          label="Model"
          value={model}
          onChange={setModel}
          models={models}
          disabled={running || loading}
        />

        <Field label="Research focus" htmlFor="research-focus">
          <textarea
            id="research-focus"
            value={focus}
            onChange={(e) => setFocus(e.target.value)}
            disabled={running}
            rows={3}
            placeholder="e.g. How does unified memory on Apple Silicon affect local LLM inference speed?"
            className={INPUT_CLASS + " scrollbar-slim resize-y"}
          />
        </Field>

        <div className="flex flex-col gap-4 sm:flex-row">
          <Select label="Depth" value={depth} onChange={setDepth} options={DEPTHS} disabled={running} />
          <Select label="Output format" value={format} onChange={setFormat} options={FORMATS} disabled={running} />
        </div>

        <Field label="Audience / tone" htmlFor="research-audience" optional>
          <input
            id="research-audience"
            value={audience}
            onChange={(e) => setAudience(e.target.value)}
            disabled={running}
            placeholder="e.g. a technical peer, or a curious beginner"
            className={INPUT_CLASS}
          />
        </Field>

        {/* Advanced: custom system prompt */}
        <div>
          <button
            type="button"
            onClick={() => setShowAdvanced((v) => !v)}
            className="flex items-center gap-1.5 text-xs font-medium text-fg-muted transition-colors hover:text-fg"
          >
            <ChevronDownIcon className={`size-3.5 transition-transform ${showAdvanced ? "" : "-rotate-90"}`} />
            Advanced
          </button>
          {showAdvanced && (
            <div className="mt-2">
              <Field label="Custom system prompt" htmlFor="research-system" note="appended">
                <textarea
                  id="research-system"
                  value={systemOverride}
                  onChange={(e) => setSystemOverride(e.target.value)}
                  disabled={running}
                  rows={2}
                  placeholder="Extra instructions for the analyst…"
                  className={INPUT_CLASS + " scrollbar-slim resize-y"}
                />
              </Field>
            </div>
          )}
        </div>

        {/* Tavily key */}
        <Field label="Tavily API key" htmlFor="research-key">
          <input
            id="research-key"
            type="password"
            value={apiKey}
            onChange={(e) => setApiKey(e.target.value)}
            disabled={running}
            placeholder="tvly-…"
            className={INPUT_CLASS + " data"}
          />
          <p className="mt-1.5 text-xs text-fg-subtle">
            Web search uses <span className="text-fg-muted">Tavily</span> — get a free key at
            tavily.com. Stored locally on this machine.
          </p>
        </Field>

        <div className="flex items-center justify-end">
          <Button variant="primary" onClick={handleRun} disabled={!canRun}>
            {running ? (
              <>
                <Spinner /> Researching…
              </>
            ) : (
              <>
                <SearchIcon className="size-4" /> Start research
              </>
            )}
          </Button>
        </div>
      </div>

      {hasRun && <ResearchResults state={state} tok={tok} />}
    </div>
  );
}

function ResearchResults({ state, tok }: { state: ResearchState; tok: number | null }) {
  return (
    <div className="flex flex-col gap-4">
      {state.phase !== "failed" && (
        <PhaseStepper phases={RESEARCH_PHASES} current={state.phase} />
      )}

      {state.phase === "failed" && (
        <div className="card border-danger/40 p-4 text-sm text-danger">{state.error}</div>
      )}

      {state.queries.length > 0 && (
        <div className="card p-5">
          <h3 className="label-caps">Search queries</h3>
          <div className="mt-2.5 flex flex-wrap gap-1.5">
            {state.queries.map((q, i) => (
              <Chip key={i}>
                <SearchIcon className="mr-1 size-3" />
                {q}
              </Chip>
            ))}
          </div>
        </div>
      )}

      {state.sources.length > 0 && (
        <div className="card p-5">
          <h3 className="label-caps">Sources</h3>
          <ol className="mt-2.5 flex flex-col gap-2.5">
            {state.sources.map((s, i) => (
              <li key={i} className="flex gap-2 text-sm">
                <span className="data shrink-0 text-fg-subtle">[{i + 1}]</span>
                <button
                  type="button"
                  onClick={() => openUrl(s.url).catch(() => {})}
                  className="min-w-0 flex-1 text-left"
                >
                  <span className="block truncate font-medium text-fg transition-colors hover:text-accent-text">
                    {s.title || s.url}
                  </span>
                  <span className="data block truncate text-xs text-fg-subtle">{s.url}</span>
                </button>
              </li>
            ))}
          </ol>
        </div>
      )}

      {(state.text || state.phase === "synthesizing") && (
        <div className="card p-5">
          <div className="flex items-center justify-between">
            <h3 className="label-caps">Brief</h3>
            {tok != null && <span className="data text-xs text-fg-muted">{formatTokSec(tok)}</span>}
          </div>
          <div className="mt-3 whitespace-pre-wrap text-sm leading-relaxed text-fg">
            {state.text}
            {state.phase === "synthesizing" && (
              <span className="ml-0.5 inline-block h-4 w-1.5 animate-pulse bg-fg align-text-bottom" aria-hidden />
            )}
          </div>
        </div>
      )}
    </div>
  );
}

