import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { RunningModel } from "../types";

/** Poll interval, matching the menu-bar tray's — this is the same question. */
const POLL_MS = 5_000;

/**
 * What Ollama currently has loaded in memory, polled from `/api/ps`.
 *
 * Polling stops while the window is hidden: residency only changes because of
 * something the user or a running turn did, and a backgrounded app hitting the
 * server forever is the kind of thing people notice in Activity Monitor.
 * `running_models` never starts the server, so a poll can't resurrect one the
 * user deliberately stopped.
 */
export function useResidency() {
  const [models, setModels] = useState<RunningModel[]>([]);

  const refresh = useCallback(async () => {
    const list = await invoke<RunningModel[]>("running_models").catch(() => [] as RunningModel[]);
    setModels(list);
    return list;
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
    // Restart immediately on becoming visible so the readout is never stale on
    // the frame the user looks at it.
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

  /** Evicts one model's weights, then refreshes so the strip settles fast. */
  const unload = useCallback(
    async (model: string) => {
      // Optimistic: the row goes immediately; the refresh is the truth.
      setModels((list) => list.filter((m) => m.name !== model));
      await invoke("unload_model", { model }).catch(() => {});
      refresh();
    },
    [refresh],
  );

  const unloadAll = useCallback(async () => {
    const loaded = models.map((m) => m.name);
    setModels([]);
    // Sequential: each unload is a tiny request, and firing N at once against a
    // server that's mid-generation buys nothing.
    for (const name of loaded) await invoke("unload_model", { model: name }).catch(() => {});
    refresh();
  }, [models, refresh]);

  const residentBytes = models.reduce((sum, m) => sum + (m.size ?? 0), 0);

  return { models, residentBytes, refresh, unload, unloadAll };
}
