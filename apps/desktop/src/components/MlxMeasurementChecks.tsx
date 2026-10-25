import type { ReactNode } from "react";
import type { NativeMlxSummary, MlxSuiteSummary } from "../types";
import { formatBytes, formatRelativeTime } from "../lib/format";
import { ChevronRightIcon } from "./icons";

const bytes = (value: number | null) => value == null ? "—" : value === 0 ? "0 B" : formatBytes(value);

export function NativeMlxResults({result, children}: {result: NativeMlxSummary; children?: ReactNode}) {
  const {report} = result;
  const load = report.attempts.find(a => a.kind === "load");
  const measured = report.attempts.filter(a => a.kind === "native_repeat");
  return <div className="flex min-w-0 flex-col gap-3">
    <div>
      <p className={`text-sm font-medium ${report.boundaries_validated ? "text-fg" : "text-warn"}`}>{result.outcome === "cancelled" ? "Native measurement stopped" : report.boundaries_validated ? "Timing and memory windows validated" : "Native measurements unverified"}</p>
      <p className="mt-1 break-words text-xs text-fg-muted">{result.model_name} · {result.runtime_version ?? "Runtime unknown"} · {formatRelativeTime(result.created_at)}</p>
      <p className="mt-1 text-xs text-fg-muted">{report.completed_repeats}/{report.planned_repeats} repeats · {report.prompt_tokens} prompt tokens / {report.decode_steps} synthetic decode steps · depth 0</p>
      {result.error && <p className="mt-2 whitespace-pre-wrap break-words text-xs text-danger">{result.error}</p>}
    </div>
    {measured.length > 0 && <div className="overflow-x-auto rounded-control border border-hair">
      <table aria-label="Native MLX measurements" className="w-full min-w-[480px] text-left text-xs">
        <thead><tr className="border-b border-hair">{["Repeat", "Prompt tok/s", "Decode steps/s", "Inference peak"].map(h => <th scope="col" className="th px-3 py-2" key={h}>{h}</th>)}</tr></thead>
        <tbody>{measured.map((a, i) => <tr key={a.plan_index} className="border-b border-hair last:border-b-0">
          <th scope="row" className="px-3 py-2 font-normal">{i + 1}{a.outcome !== "completed" && <span className="ml-2 text-warn">{a.outcome}</span>}</th>
          <td className="data px-3 py-2">{a.prompt_tps?.toFixed(1) ?? "—"}</td>
          <td className="data px-3 py-2">{a.decode_steps_per_second?.toFixed(1) ?? "—"}</td>
          <td className="data px-3 py-2">{bytes(a.peak_bytes)}</td>
        </tr>)}</tbody>
      </table>
    </div>}
    <p className="text-xs text-fg-muted">Load-inclusive peak: <span className="data">{bytes(load?.peak_bytes ?? null)}</span>. MLX allocator bytes include resident weights; they are not total Mac memory.</p>
    <p className="text-xs text-fg-muted">Synthetic compute only. Quality equivalence and instrumentation overhead are unchecked; comparisons stay unavailable.</p>
    <details className="group/native">
      <summary className="flex cursor-pointer list-none items-center gap-1.5 text-xs text-fg-muted hover:text-fg [&::-webkit-details-marker]:hidden"><ChevronRightIcon className="size-3.5 transition-transform group-open/native:rotate-90" />Measurement details</summary>
      <ul className="mt-2 space-y-1 text-xs text-fg-muted">{report.boundary_checks.map(c => <li key={c.name}>{c.name}: <span className={c.passed ? "text-fg" : "text-warn"}>{c.passed ? "checked" : "failed"}</span></li>)}</ul>
      {report.attempts.map(a => <p className="mt-2 break-words text-xs text-fg-muted" key={a.plan_index}>
        {a.is_warmup ? "Warmup" : a.kind.replaceAll("_", " ")} · {a.outcome} · active baseline {bytes(a.baseline_active_bytes)} · cached baseline {bytes(a.baseline_cache_bytes)} · peak {bytes(a.peak_bytes)} · active at end {bytes(a.end_active_bytes)} · cached at end {bytes(a.end_cache_bytes)}
        {a.prompt_ns != null && <> · prompt {(a.prompt_ns / 1e6).toFixed(2)} ms</>}{a.decode_ns != null && <> · decode {(a.decode_ns / 1e6).toFixed(2)} ms</>}{a.load_ns != null && <> · load {(a.load_ns / 1e6).toFixed(2)} ms</>}
        {a.errors.length > 0 && <span className="block text-warn">{a.errors.join(", ")}</span>}
      </p>)}
      {children}
    </details>
  </div>;
}

export function MlxSuiteChecks({result}: {result: MlxSuiteSummary}) {
  const r=result.report;
  return <div className="flex flex-col gap-2 text-xs text-fg-muted">
    <p>{result.runtime_version ?? "MLX"} · {r.boundaries_validated ? "Timing and allocator checks passed" : "Measurement checks incomplete"}</p>
    <p>Normal text generation with a fresh prompt cache. MLX-LM phase rates are diagnostic; first-token and EOS conventions differ from Ollama.</p>
    <p>Client latency includes worker IPC and formatting. Quality equivalence and cross-runtime comparisons are unchecked.</p>
    <p>Load allocator peak: <span className="data">{bytes(r.load_peak_bytes)}</span>. Allocator bytes include resident weights; they are not process RSS or total Mac memory.</p>
    <details className="group/windows">
      <summary className="flex cursor-pointer list-none items-center gap-1.5 hover:text-fg [&::-webkit-details-marker]:hidden"><ChevronRightIcon className="size-3.5 transition-transform group-open/windows:rotate-90" />Checks and memory windows</summary>
      <ul className="mt-2 space-y-1">{r.boundary_checks.map(c=><li key={c.name}>{c.name}: {c.passed ? "checked" : "failed"}</li>)}</ul>
      <div className="mt-2 overflow-x-auto rounded-control border border-hair"><table aria-label="MLX allocator windows" className="w-full text-left">
        <thead><tr className="border-b border-hair">{["Attempt", "Active baseline", "Cached baseline", "Inference peak"].map(h=><th className="th whitespace-nowrap px-3 py-2" key={h}>{h}</th>)}</tr></thead>
        <tbody>{r.memory.map(w=><tr key={w.plan_index} className="border-b border-hair last:border-0"><th className="data px-3 py-2 font-normal">{w.plan_index+1}</th><td className="data whitespace-nowrap px-3 py-2">{bytes(w.baseline_active_bytes)}</td><td className="data whitespace-nowrap px-3 py-2">{bytes(w.baseline_cache_bytes)}</td><td className="data whitespace-nowrap px-3 py-2">{bytes(w.peak_bytes)}</td></tr>)}</tbody>
      </table></div>
    </details>
  </div>;
}

