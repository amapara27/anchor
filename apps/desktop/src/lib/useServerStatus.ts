import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { ServerStatus } from "../types";

/** Live Ollama server status for the Settings panel; fetched on mount, refreshable. */
export function useServerStatus() {
  const [status, setStatus] = useState<ServerStatus | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(() => {
    setLoading(true);
    invoke<ServerStatus>("get_server_status")
      .then(setStatus)
      // The command itself failed, so we know nothing about the host — claim
      // local so the "not on this Mac" warning can't fire on a read error.
      .catch(() => setStatus({ reachable: false, version: null, managed: false, host: "", local: true }))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  return { status, loading, refresh };
}
