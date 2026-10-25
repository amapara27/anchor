import { useEffect, useState, type ReactNode } from "react";
import type { CalibrationSummary } from "../types";
import { exportEvidence } from "../lib/exportEvidence";
import { formatRelativeTime } from "../lib/format";
import { GhostButton } from "./PageHeader";
import { ChevronRightIcon, StopIcon } from "./icons";

const PROBE_NAMES: Record<string, string> = {
  after_unload: "Fresh prompt",
  identical_repeat: "Repeated prompt",
  shared_prefix: "Shared prefix",
  changed_prefix: "Changed prefix",
  cap_one: "One-token limit",
  natural_stop: "Natural completion",
  unicode: "Unicode input",
  reasoning: "Reasoning output",
};

export function CalibrationResults({ result, initiallyExpanded = false, children }: { result: CalibrationSummary; initiallyExpanded?: boolean; children?: ReactNode }) {
  const [expanded, setExpanded] = useState(initiallyExpanded);
  const { probes } = result.report;
  const matched = probes.filter(p => p.input_count === "cross_checked_for_probe").length;
  const mismatch = probes.some(p => p.input_count === "mismatch" || p.finish === "length_count_mismatch");
  const status = mismatch ? "A count mismatch was found" : result.outcome === "completed" ? "Checks recorded"
    : result.outcome === "running" ? "Unfinished check" : result.outcome === "cancelled" ? "Validation stopped" : "Some checks did not finish";
  return <div className="flex min-w-0 flex-col gap-3">
    <div>
      <p className={`text-sm font-medium ${mismatch || result.outcome === "failed" ? "text-warn" : "text-fg"}`}>{status}</p>
      <p className="mt-1 text-xs text-fg-muted"><span className="data">{probes.length}/{result.planned_attempts}</span> requests recorded · {matched > 0 ? `${matched}/${probes.length} input counts matched` : "Input counts unverified"}</p>
      <p className="mt-1 text-xs text-fg-muted">Ollama {result.runtime_version ?? "version unknown"} · requested 4K context · {formatRelativeTime(result.created_at)}</p>
      {result.error && <p className="mt-2 break-words text-xs text-danger">{result.error}</p>}
    </div>
    <p className="text-xs text-fg-muted">Engine counts and rates remain diagnostic. Checks cover this model, runtime and request set.</p>
    {probes.length > 0 && <details className="group/checks" open={expanded} onToggle={e => setExpanded(e.currentTarget.open)}>
      <summary className="flex cursor-pointer list-none items-center gap-1.5 text-xs text-fg-muted hover:text-fg [&::-webkit-details-marker]:hidden"><ChevronRightIcon className="size-3.5 transition-transform group-open/checks:rotate-90" />Request details</summary>
      <div className="mt-2 overflow-x-auto rounded-control border border-hair">
      <table aria-label="Validation checks" className="w-full min-w-[620px] text-left text-xs">
        <thead><tr className="border-b border-hair">
          {["Request", "Input count", "Cache", "Finish", "Answer / reasoning"].map(title => <th key={title} scope="col" className="th whitespace-nowrap px-3 py-2">{title}</th>)}
        </tr></thead>
        <tbody>{probes.map((p, index) => <tr key={p.attempt_id} className="border-b border-hair last:border-b-0">
          <th scope="row" className="px-3 py-2 font-normal">
            <span>{PROBE_NAMES[result.probe_names[index]] ?? result.probe_names[index] ?? "Request"}</span>
            {p.outcome !== "completed" && <span className="mt-1 block text-warn">{p.outcome.replaceAll("_", " ")}</span>}
          </th>
          <td className={`px-3 py-2 ${p.input_count === "mismatch" ? "text-danger" : "text-fg-muted"}`}>{p.input_count === "cross_checked_for_probe" ? "Matched" : p.input_count === "mismatch" ? "Mismatch" : "Unverified"}</td>
          <td className="px-3 py-2 text-fg-muted">{p.cache === "observed_uncached" ? "No reuse observed" : p.cache === "observed_prefix_reuse" ? "Prefix reused" : "Unknown"}</td>
          <td className={`px-3 py-2 ${p.finish === "length_count_mismatch" ? "text-danger" : "text-fg-muted"}`}>
            {p.finish === "cap_reached" ? "Limit reached" : p.finish === "reported_stop_eos_or_stop_sequence" ? "Stop reported" : p.finish === "length_count_mismatch" ? "Limit mismatch" : "Unknown"}
            {p.stream !== "valid_terminal_and_transport_close" && <span className="mt-1 block text-warn">Incomplete stream</span>}
          </td>
          <td className="data whitespace-nowrap px-3 py-2 text-fg-muted">{p.visible_tokens ?? "—"} / {p.reasoning_tokens ?? "—"}</td>
        </tr>)}</tbody>
      </table>
    </div>
      <p className="mt-2 text-xs text-fg-muted">Answer / reasoning: retokenized text; hidden end tokens may differ. — means unknown.</p>
      {children}
    </details>}
    {probes.length === 0 && children}
  </div>;
}

export function CalibrationPanel({ modelId, result, running, busy, loading, progress, error, onRun, onStop }: {
  modelId: string | null;
  result: CalibrationSummary | null;
  running: boolean;
  busy: boolean;
  loading: boolean;
  progress: string | null;
  error: string | null;
  onRun: () => void;
  onStop: () => void;
}) {
  const [includeContent, setIncludeContent] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [exportError, setExportError] = useState<string | null>(null);
  useEffect(() => { setIncludeContent(false); setExportError(null); }, [modelId]);
  const save = async () => {
    if (!result) return;
    setExporting(true); setExportError(null);
    try { await exportEvidence(result.session_id, includeContent); }
    catch (e) { setExportError(String(e)); }
    finally { setExporting(false); }
  };
  const key = progress?.replace(/^calibrating /, "");
  const message = key && PROBE_NAMES[key] ? `Checking ${PROBE_NAMES[key].toLowerCase()}…` : progress;
  return <section aria-label="Measurement validation" className="min-w-0 border-t border-hair pt-4">
    <div className="flex flex-wrap items-center justify-between gap-3">
      <h2 className="text-sm font-medium">Measurement validation</h2>
      {running ? <GhostButton onClick={onStop} tone="danger"><StopIcon className="size-3.5" />Stop validation</GhostButton>
        : <GhostButton onClick={onRun} disabled={!modelId || busy}>Validate measurements</GhostButton>}
    </div>
    <p className="mt-1 max-w-[75ch] text-xs leading-relaxed text-fg-muted">Runs 7–8 test requests to check Ollama’s token counts, cache reuse and response completion. Saves a report without tuning the model or changing benchmark results.</p>
    {running && <p role="status" aria-live="polite" className="mt-3 text-sm text-fg">{message ?? "Checking Ollama…"}</p>}
    {!running && progress && <p role="status" className="mt-3 text-xs text-fg-muted">{progress}</p>}
    {error && <p role="alert" className="mt-3 break-words text-xs text-danger">{error} Try again when Ollama is available.</p>}
    {!running && result?.model_name === modelId && <div className="mt-3"><CalibrationResults key={result.session_id} result={result}>
      <div className="mt-3 flex flex-wrap items-center gap-3">
        <label className="flex items-center gap-2 text-xs text-fg-muted"><input type="checkbox" checked={includeContent} onChange={e => setIncludeContent(e.target.checked)} />Include prompts and output</label>
        <GhostButton className="h-7 text-xs" disabled={!includeContent || exporting} onClick={() => void save()}>{exporting ? "Exporting…" : "Export evidence"}</GhostButton>
        {exportError && <p role="alert" className="w-full break-words text-xs text-danger">{exportError}</p>}
      </div>
    </CalibrationResults></div>}
    {!running && !result && <p className="mt-3 text-xs text-fg-muted">{loading ? "Loading the last check…" : modelId ? "No validation recorded for this model." : "Install a model to check its measurements."}</p>}
  </section>;
}
