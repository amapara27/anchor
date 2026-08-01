import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { AgentRun, AgentRunDetail } from "../types";

/**
 * Agent run history from SQLite, newest first. `reload` after a run settles —
 * runs are written by whoever executed them (`useResearch`), not by this hook.
 */
export function useAgentRuns() {
  const [runs, setRuns] = useState<AgentRun[]>([]);
  const [loading, setLoading] = useState(true);

  const reload = useCallback(() => {
    invoke<AgentRun[]>("agent_runs")
      .then(setRuns)
      .catch(() => setRuns([])) // history is a record; a read failure isn't fatal
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => reload(), [reload]);

  return { runs, loading, reload };
}

/** Parses a run's stored payload. Unreadable JSON degrades to an empty detail. */
export function runDetail(run: AgentRun | null | undefined): AgentRunDetail {
  const empty: AgentRunDetail = { output: "", queries: [], sources: [], phases: [] };
  if (!run?.detail_json) return empty;
  try {
    return { ...empty, ...(JSON.parse(run.detail_json) as AgentRunDetail) };
  } catch {
    return empty;
  }
}
