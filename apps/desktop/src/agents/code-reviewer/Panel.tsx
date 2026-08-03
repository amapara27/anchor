import { useEffect, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";
import { useModels } from "../../lib/useModels";
import { formatTokSec, tokensPerSecond } from "../../lib/format";
import { ModelPicker } from "../../components/ModelPicker";
import { Select } from "../../components/ui/Select";
import { Button } from "../../components/ui/Button";
import { Chip } from "../../components/ui/Chip";
import { Markdown } from "../../components/ui/Markdown";
import { FileIcon, LayersIcon, SparkleIcon } from "../../components/icons";
import { AgentHeader, Field, INPUT_CLASS, PhaseStepper, Spinner } from "../AgentShell";
import { baseName, pickFile } from "../pickFile";
import { useAgent } from "../useAgent";
import { CODE_REVIEWER_PHASES, FILE_PHASES } from "./phases";

/** Suggested default — the strongest code model most people already have. */
const DEFAULT_MODEL = "qwen2.5-coder:7b";

/** What the run is pointed at. Mirrors the `Target` split in the executor. */
type Source = "codebase" | "file" | "diff";

const SOURCES: { value: Source; label: string }[] = [
  { value: "codebase", label: "Whole codebase" },
  { value: "file", label: "Single file" },
  { value: "diff", label: "Pasted diff" },
];

/**
 * The Code Reviewer panel: point a local model at a folder, a file, or a diff and
 * get back a walkthrough of what the code does plus bugs and optimizations.
 */
export function CodeReviewerPanel({ onBack }: { onBack: () => void }) {
  const { models, loading } = useModels();
  const { state, running, run, reset } = useAgent("code-reviewer", "run_code_reviewer");

  const [model, setModel] = useState("");
  const [source, setSource] = useState<Source>("codebase");
  const [path, setPath] = useState("");
  const [diff, setDiff] = useState("");
  const [focus, setFocus] = useState("");

  // Default the model once the library loads: prefer the coder model, else the
  // first installed one.
  useEffect(() => {
    if (model || models.length === 0) return;
    const suggested = models.find((m) => m.id === DEFAULT_MODEL);
    setModel(suggested?.id ?? models.find((m) => m.status === "installed")?.id ?? "");
  }, [models, model]);

  // The native picker: a folder for a codebase, the shared code filter for a file.
  const choose = async () => {
    const picked =
      source === "codebase"
        ? await open({ directory: true, multiple: false })
        : await pickFile("code");
    if (typeof picked === "string") setPath(picked);
  };

  const hasTarget = source === "diff" ? diff.trim().length > 0 : path.length > 0;
  const canRun = model !== "" && hasTarget && !running;
  const hasRun = state.phase !== "idle";
  const tok = tokensPerSecond(state.stats);

  const handleRun = () =>
    run({
      model,
      task: source === "diff" ? "pasted diff" : baseName(path),
      config: {
        model,
        path: source === "diff" ? undefined : path,
        diff: source === "diff" ? diff.trim() : undefined,
        focus: focus.trim() || undefined,
      },
      firstPhase: source === "codebase" ? "scanning" : "reading",
    });

  return (
    <div className="flex flex-col gap-6">
      <AgentHeader
        title="Code Reviewer"
        subtitle="Reads your code locally, explains how it works, then flags bugs and optimizations."
        onBack={onBack}
        onReset={reset}
        resetLabel="New review"
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

        <Select label="Review" value={source} onChange={setSource} options={SOURCES} disabled={running} />

        {source === "diff" ? (
          <Field label="Unified diff" htmlFor="review-diff">
            <textarea
              id="review-diff"
              value={diff}
              onChange={(e) => setDiff(e.target.value)}
              disabled={running}
              rows={8}
              placeholder="Paste the output of `git diff`…"
              className={INPUT_CLASS + " data scrollbar-slim resize-y text-xs"}
            />
          </Field>
        ) : (
          <Field label={source === "codebase" ? "Project folder" : "Source file"} htmlFor="review-path">
            <div className="flex items-center gap-3">
              <Button id="review-path" onClick={choose} disabled={running}>
                {source === "codebase" ? <LayersIcon className="size-4" /> : <FileIcon className="size-4" />}
                {path ? "Change…" : "Choose…"}
              </Button>
              {path ? (
                <span className="min-w-0">
                  <span className="block truncate text-sm font-medium text-fg">{baseName(path)}</span>
                  <span className="data block truncate text-xs text-fg-subtle">{path}</span>
                </span>
              ) : (
                <span className="text-sm text-fg-subtle">
                  {source === "codebase" ? "Nothing selected — pick a project root." : "Nothing selected."}
                </span>
              )}
            </div>
          </Field>
        )}

        <Field label="Focus" htmlFor="review-focus" optional>
          <input
            id="review-focus"
            value={focus}
            onChange={(e) => setFocus(e.target.value)}
            disabled={running}
            placeholder="e.g. explain the data flow, or focus on error handling"
            className={INPUT_CLASS}
          />
        </Field>

        <div className="flex items-center justify-end">
          <Button variant="primary" onClick={handleRun} disabled={!canRun}>
            {running ? (
              <>
                <Spinner /> Reviewing…
              </>
            ) : (
              <>
                <SparkleIcon className="size-4" /> Start review
              </>
            )}
          </Button>
        </div>
      </div>

      {hasRun && (
        <div className="flex flex-col gap-4">
          {state.phase !== "failed" && (
            <PhaseStepper
              phases={source === "codebase" ? CODE_REVIEWER_PHASES : FILE_PHASES}
              current={state.phase}
            />
          )}

          {state.phase === "failed" && (
            <div className="card border-danger/40 p-4 text-sm text-danger">{state.error}</div>
          )}

          {state.notes.length > 0 && (
            <div className="card p-5">
              <h3 className="label-caps">Files read</h3>
              <div className="mt-2.5 flex flex-wrap gap-1.5">
                {state.notes.map((n, i) => (
                  <Chip key={i} title={n.label} className={n.label === "skipped" ? "text-warn" : ""}>
                    <FileIcon className="mr-1 size-3" />
                    <span className="data">{n.text}</span>
                  </Chip>
                ))}
              </div>
            </div>
          )}

          {(state.text || state.phase === "reviewing") && (
            <div className="card p-5">
              <div className="flex items-center justify-between">
                <h3 className="label-caps">Review</h3>
                {tok != null && <span className="data text-xs text-fg-muted">{formatTokSec(tok)}</span>}
              </div>
              {/* Markdown only once it's settled — a half-written fence renders as noise. */}
              <div className="mt-3 text-sm leading-relaxed text-fg">
                {state.phase === "reviewing" ? (
                  <span className="whitespace-pre-wrap">
                    {state.text}
                    <span
                      className="ml-0.5 inline-block h-4 w-1.5 animate-pulse bg-fg align-text-bottom"
                      aria-hidden
                    />
                  </span>
                ) : (
                  <Markdown>{state.text}</Markdown>
                )}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
