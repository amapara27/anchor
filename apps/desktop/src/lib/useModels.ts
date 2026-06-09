import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { DownloadState, LibraryModel, Model } from "../types";
import { buildLibrary } from "./catalog";

/** Per-model, session-local annotations layered on top of catalog data. */
interface Annotation {
  tags: string[];
  note: string;
}

/**
 * Owns the model-library data: fetches installed models over Tauri, joins them
 * against the catalog, and tracks local-only state (downloads, tags, notes).
 *
 * Download / remove are simulated for now — `anchor-hub` exposes no such
 * commands yet. They're structured so swapping in real `download_model` /
 * `remove_model` commands later is a one-line change inside each action.
 */
export function useModels() {
  const [base, setBase] = useState<LibraryModel[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  // Local overlays, kept out of `base` so a refetch never clobbers them.
  const [installedOverride, setInstalledOverride] = useState<Set<string>>(new Set());
  const [annotations, setAnnotations] = useState<Record<string, Annotation>>({});
  const [downloads, setDownloads] = useState<Record<string, DownloadState>>({});

  const timers = useRef<Record<string, ReturnType<typeof setInterval>>>({});

  const load = useCallback(() => {
    setLoading(true);
    invoke<Model[]>("list_models")
      .then((installed) => {
        setBase(buildLibrary(installed));
        setError(null);
      })
      .catch((e) => {
        // Non-fatal: the catalog of available models is frontend data, so still
        // render it. We just couldn't confirm what's installed on disk.
        setBase(buildLibrary([]));
        setError(String(e));
      })
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    load();
    const t = timers.current;
    return () => {
      // Tear down any in-flight simulated downloads on unmount.
      Object.values(t).forEach(clearInterval);
    };
  }, [load]);

  // Merge base data with local overlays into what the UI actually renders.
  const models: LibraryModel[] = base.map((m) => {
    const anno = annotations[m.id];
    return {
      ...m,
      status: installedOverride.has(m.id) ? "installed" : m.status,
      tags: anno?.tags ?? m.tags,
      note: anno?.note ?? m.note,
    };
  });

  const startDownload = useCallback((model: LibraryModel) => {
    setDownloads((d) => {
      if (d[model.id]?.status === "downloading") return d; // already running
      return {
        ...d,
        [model.id]: {
          modelId: model.id,
          progress: 0,
          receivedBytes: 0,
          status: "downloading",
        },
      };
    });

    const total = model.spec.download_bytes;
    const stepBytes = total / 40; // ~40 ticks to completion
    timers.current[model.id] = setInterval(() => {
      setDownloads((d) => {
        const cur = d[model.id];
        if (!cur || cur.status !== "downloading") return d;
        const received = Math.min(total, cur.receivedBytes + stepBytes);
        const progress = received / total;
        if (progress >= 1) {
          clearInterval(timers.current[model.id]);
          delete timers.current[model.id];
          // Promote to "verifying" briefly, then mark installed.
          window.setTimeout(() => {
            setInstalledOverride((s) => new Set(s).add(model.id));
            setDownloads((dd) => {
              const next = { ...dd };
              delete next[model.id];
              return next;
            });
          }, 450);
          return { ...d, [model.id]: { ...cur, progress: 1, receivedBytes: total, status: "verifying" } };
        }
        return { ...d, [model.id]: { ...cur, progress, receivedBytes: received } };
      });
    }, 120);
  }, []);

  const cancelDownload = useCallback((modelId: string) => {
    clearInterval(timers.current[modelId]);
    delete timers.current[modelId];
    setDownloads((d) => {
      const next = { ...d };
      delete next[modelId];
      return next;
    });
  }, []);

  const removeModel = useCallback((modelId: string) => {
    setInstalledOverride((s) => {
      const next = new Set(s);
      next.delete(modelId);
      return next;
    });
  }, []);

  const setTags = useCallback((modelId: string, tags: string[]) => {
    setAnnotations((a) => ({ ...a, [modelId]: { tags, note: a[modelId]?.note ?? "" } }));
  }, []);

  const setNote = useCallback((modelId: string, note: string) => {
    setAnnotations((a) => ({ ...a, [modelId]: { note, tags: a[modelId]?.tags ?? [] } }));
  }, []);

  return {
    models,
    loading,
    error,
    downloads,
    reload: load,
    startDownload,
    cancelDownload,
    removeModel,
    setTags,
    setNote,
  };
}
