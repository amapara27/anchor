import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { ServerStatus } from "../types";

/** Poll interval — matches useResidency's, so the title bar's two live pills
 *  never visibly disagree for a few seconds after `ollama serve`/kill. */
const POLL_MS = 5_000;

/**
 * Live Ollama server status for the title bar and Settings panel.
 *
 * Polls like useResidency: stops while the window is hidden, restarts (with an
 * immediate refresh) on becoming visible again. `get_server_status` never
 * starts the server itself, so a background poll can't resurrect one the user
 * deliberately stopped.
 */
export function useServerStatus() {
  const [status, setStatus] = useState<ServerStatus | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(() => {
    setLoading(true);
    return invoke<ServerStatus>("get_server_status")
      .then(setStatus)
      // The command itself failed, so we know nothing about the host — claim
      // local so the "not on this Mac" warning can't fire on a read error.
      .catch(() => setStatus({ reachable: false, version: null, managed: false, host: "", local: true }))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    let timer: number | undefined;

    const tick = () => {
      refresh();
      timer = window.setTimeout(tick, POLL_MS);
    };
    const stop = () => {
      window.clearTimeout(timer);
      timer = undefined;
    };
    const onVisibility = () => {
      stop();
      if (!document.hidden) tick();
    };

    onVisibility();
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      stop();
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [refresh]);

  return { status, loading, refresh };
}
