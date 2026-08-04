import { useCallback, useEffect, useRef, useState } from "react";
import { Channel, invoke } from "@tauri-apps/api/core";
import type { AgentRunDetail } from "../types";
import { applyEvent, INITIAL, mark, TERMINAL, tracePhases, type Mark } from "./fold";
import type { AgentEvent, AgentState } from "./types";

/** Everything a settled run needs to file itself, gathered as it streamed. */
interface RunContext {
  startedMs: number;
  model: string;
  task: string;
  notes: string[];
  sources: { title: string; url: string }[];
  marks: Mark[];
}

/**
 * Files a settled run in the history the Agents page reads. Best-effort: the
 * answer is already on screen, so a failed write must not surface as a run
 * failure.
 */
function saveRun(
  agentId: string,
  event: Extract<AgentEvent, { kind: "result" | "failed" }>,
  ctx: RunContext,
): void {
  const endedMs = Date.now();
  const failed = event.kind === "failed";
  const detail: AgentRunDetail = {
    output: failed ? "" : event.response,
    // Notes reuse the run detail's `queries` slot — the inspector renders it as
    // the run's mid-flight breadcrumbs whatever the agent called them.
    queries: ctx.notes,
    sources: ctx.sources,
    phases: tracePhases(ctx.marks, endedMs),
    error: failed ? event.message : undefined,
  };
  invoke("save_agent_run", {
    run: {
      id: crypto.randomUUID(),
      agent_id: agentId,
      model: ctx.model,
      task: ctx.task,
      status: failed ? "failed" : "completed",
      started_ms: ctx.startedMs,
      duration_ms: endedMs - ctx.startedMs,
      tokens: failed ? null : (event.stats.eval_count ?? null),
      detail_json: JSON.stringify(detail),
    },
  }).catch(() => {});
}

/** What `run` needs beyond the agent's own config. */
export interface RunOptions {
  /** Model id, stored on the run and evicted if the user navigates away. */
  model: string;
  /** What was asked — the run's subtitle in the history. */
  task: string;
  /** The agent's own config, passed straight to the command as `config`. */
  config: object;
  /** The phase the run starts in, so the trace has a first mark. */
  firstPhase: string;
}

/**
 * Owns a single agent run: wires a Tauri `Channel`, reduces the streamed events,
 * persists the settled run, and evicts the model on cancel/unmount.
 *
 * Every agent shares this rather than reimplementing it — the stale-run guard,
 * the closure-scoped accumulators and the phase-trace ordering are the subtlest
 * code in the feature and are not worth getting wrong once per agent.
 *
 * @param agentId matches the template id in `lib/workflows.ts`
 * @param command the Tauri command name, e.g. `run_batch_processor`
 */
export function useAgent(agentId: string, command: string) {
  const [state, setState] = useState<AgentState>(INITIAL);
  const runId = useRef(0);
  // The model still loaded server-side, so cancel/unmount can evict it. Cleared
  // once a run ends (agents use keep_alive:0, so it's already gone by then).
  const activeModel = useRef<string | null>(null);

  const running = !TERMINAL.includes(state.phase);

  const unload = useCallback(() => {
    const model = activeModel.current;
    if (!model) return;
    activeModel.current = null;
    invoke("unload_model", { model }).catch(() => {}); // best-effort
  }, []);

  const run = useCallback(
    (opts: RunOptions) => {
      const myRun = ++runId.current;
      activeModel.current = opts.model;
      setState({ ...INITIAL, phase: opts.firstPhase });

      // Run-local record of what gets stored. Kept in the closure rather than in
      // state so persisting never has to read through a setState updater.
      const startedMs = Date.now();
      const ctx: RunContext = {
        startedMs,
        model: opts.model,
        task: opts.task,
        notes: [],
        sources: [],
        marks: [{ phase: opts.firstPhase, at: startedMs }],
      };

      const channel = new Channel<AgentEvent>();
      channel.onmessage = (event) => {
        if (runId.current !== myRun) return; // stale run — ignore
        if (event.kind === "note") ctx.notes.push(event.text);
        if (event.kind === "source") ctx.sources.push({ title: event.title, url: event.url });
        if (event.kind === "status") mark(ctx.marks, event.phase, Date.now());
        // Run finished: weights are already evicted, so don't re-unload later.
        if (event.kind === "result" || event.kind === "failed") {
          activeModel.current = null;
          saveRun(agentId, event, ctx);
        }
        setState((s) => applyEvent(s, event));
      };

      invoke(command, { config: opts.config, onEvent: channel }).catch((e) => {
        if (runId.current !== myRun) return;
        activeModel.current = null; // command failed before anything loaded
        setState((s) => ({ ...s, phase: "failed", error: String(e) }));
      });
    },
    [agentId, command],
  );

  const reset = useCallback(() => {
    runId.current++; // invalidate in-flight events
    unload(); // cancelling mid-run: evict the loaded model
    setState(INITIAL);
  }, [unload]);

  // Navigating away mid-run must not strand a loaded model.
  useEffect(() => () => unload(), [unload]);

  return { state, running, run, reset };
}
