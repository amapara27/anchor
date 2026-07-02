import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

/**
 * Fetches which installed models have a newer version upstream, as a
 * `modelId -> updateAvailable` record. The backend compares each model's local
 * manifest digest against the Ollama registry (heavily cached, best-effort), so
 * this is safe to call on mount: it never throws and defaults to "no updates"
 * when Ollama or the registry is unreachable.
 */
export function useUpdates(): Record<string, boolean> {
  const [updates, setUpdates] = useState<Record<string, boolean>>({});

  useEffect(() => {
    let alive = true;
    invoke<[string, boolean][]>("check_updates")
      .then((pairs) => {
        if (alive) setUpdates(Object.fromEntries(pairs));
      })
      // Update checks are advisory; a failure just means no badges this session.
      .catch(() => {});
    return () => {
      alive = false;
    };
  }, []);

  return updates;
}
