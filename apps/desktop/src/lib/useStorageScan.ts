import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { StorageScan } from "../types";

/**
 * Ollama's on-disk model store: dedupe savings and orphaned blobs. Fetched
 * once on mount; `refresh` re-walks the store (the "Rescan disk" button). A
 * full scan isn't something to poll on an interval like residency/status.
 *
 * `scan` is `null` before the first load or when the store doesn't exist yet
 * (nothing pulled).
 */
export function useStorageScan() {
  const [scan, setScan] = useState<StorageScan | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(() => {
    setLoading(true);
    return invoke<StorageScan | null>("scan_storage")
      .then((s) => {
        setScan(s);
        setError(null);
      })
      .catch((e) => setError(String(e)))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const clean = useCallback(
    async (target: StorageScan) => {
      await invoke("clean_orphaned_blobs", { scan: target }).catch(() => {});
      await refresh();
    },
    [refresh],
  );

  return { scan, loading, error, refresh, clean };
}
