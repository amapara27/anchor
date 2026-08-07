import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import { Channel, invoke } from "@tauri-apps/api/core";
import type { DownloadState, LibraryModel, Model, ModelProfile, PullProgress } from "../types";
import { buildLibrary } from "./catalog";

/** Per-model, session-local annotations layered on top of catalog data. */
interface Annotation {
  tags: string[];
  note: string;
}

/**
 * Owns the model-library data: fetches installed models over Tauri (which the
 * backend syncs from Ollama into a SQLite cache), joins them against the
 * catalog, and drives real downloads/removals against `anchor-hub`.
 *
 * Tags and notes remain session-local overlays — the registry doesn't persist
 * them yet — kept out of `base` so a refetch never clobbers them.
 */
function useModelsState() {
  const [base, setBase] = useState<LibraryModel[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const [annotations, setAnnotations] = useState<Record<string, Annotation>>({});
  const [downloads, setDownloads] = useState<Record<string, DownloadState>>({});

  // Models the user canceled: late-arriving pull events are ignored.
  const canceled = useRef<Set<string>>(new Set());
  // Pulls this hook has in flight. A ref, not `downloads`, so `startDownload`
  // keeps a stable identity — with `downloads` in its dep array it changed on
  // every progress tick and re-rendered every consumer holding it as a prop.
  const inFlight = useRef<Set<string>>(new Set());

  const load = useCallback(() => {
    setLoading(true);
    // The catalog of available models comes from the backend (curated profiles)
    // and is bundled, so it effectively never fails — fall back to empty so
    // installed models still render if it somehow does.
    const catalog = invoke<ModelProfile[]>("list_catalog").catch(
      () => [] as ModelProfile[],
    );

    Promise.all([catalog, invoke<Model[]>("list_models")])
      .then(([cat, installed]) => {
        setBase(buildLibrary(installed, cat));
        setError(null);
      })
      .catch((e) => {
        // Ollama unreachable: still render the catalog (available models). The
        // catalog promise already resolved with a fallback, so reuse it here so
        // a `list_models` failure doesn't also hide the available models.
        catalog.then((cat) => setBase(buildLibrary([], cat)));
        setError(String(e));
      })
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  // Merge base data with local annotation overlays into what the UI renders.
  const models: LibraryModel[] = base.map((m) => {
    const anno = annotations[m.id];
    return {
      ...m,
      tags: anno?.tags ?? m.tags,
      note: anno?.note ?? m.note,
    };
  });

  const clearDownload = useCallback((modelId: string) => {
    setDownloads((d) => {
      const next = { ...d };
      delete next[modelId];
      return next;
    });
  }, []);

  /**
   * Pulls a model by Ollama id.
   *
   * Takes an id rather than a `LibraryModel` because that's all it ever used,
   * and because Browse pulls tags (`llama3.1:70b-q2_K`) that aren't in the
   * catalog and have no `LibraryModel` to hand.
   */
  const startDownload = useCallback(
    (id: string) => {
      if (inFlight.current.has(id)) return; // already running
      inFlight.current.add(id);
      canceled.current.delete(id);
      setDownloads((d) => ({
        ...d,
        [id]: { modelId: id, progress: 0, receivedBytes: 0, status: "downloading" },
      }));

      const channel = new Channel<PullProgress>();
      channel.onmessage = (msg) => {
        if (canceled.current.has(id)) return;
        setDownloads((d) => {
          const cur = d[id];
          if (!cur) return d;
          return { ...d, [id]: applyProgress(cur, msg) };
        });
      };

      invoke("download_model", { id, onEvent: channel })
        .then(() => {
          if (canceled.current.has(id)) return;
          // Briefly show "done", then refresh from the backend so the model
          // flips to installed with its real on-disk specs.
          setDownloads((d) => {
            const cur = d[id];
            if (!cur) return d;
            return { ...d, [id]: { ...cur, progress: 1, status: "done" } };
          });
          window.setTimeout(() => clearDownload(id), 400);
        })
        .catch((e) => {
          // A cancel resolves here as `Err("cancelled")` — a normal terminal
          // state, not a failure to report.
          if (canceled.current.has(id) || String(e).includes("cancelled")) return;
          setDownloads((d) => {
            const cur = d[id];
            if (!cur) return d;
            return { ...d, [id]: { ...cur, status: "error", error: String(e) } };
          });
        })
        .finally(() => {
          inFlight.current.delete(id);
          // Always re-list, whatever the outcome. This used to be skipped for a
          // canceled id, so a pull that finished before the cancel landed left
          // the model on disk and invisible until some other refresh.
          load();
        });
    },
    [load, clearDownload],
  );

  const cancelDownload = useCallback(
    (modelId: string) => {
      // Stops the pull server-side: `cancel_download` trips the flag the stream
      // loop checks, which drops the connection and makes Ollama abandon the
      // transfer. Partial blobs stay, so re-pulling resumes rather than restarts.
      canceled.current.add(modelId);
      invoke("cancel_download", { id: modelId }).catch(() => {});
      clearDownload(modelId);
    },
    [clearDownload],
  );

  const removeModel = useCallback(
    async (modelId: string) => {
      try {
        await invoke("remove_model", { id: modelId });
      } catch (e) {
        setError(String(e));
      } finally {
        load();
      }
    },
    [load],
  );

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

type ModelsValue = ReturnType<typeof useModelsState>;

const ModelsContext = createContext<ModelsValue | null>(null);

/**
 * Single owner of the model-library state, mounted once in `App`. Every page
 * shares one sync, one download map, and one error state — a download started
 * in the library stays visible from any tab, and tab switches don't re-sync.
 */
export function ModelsProvider({ children }: { children: React.ReactNode }) {
  const value = useModelsState();
  return <ModelsContext.Provider value={value}>{children}</ModelsContext.Provider>;
}

/** The shared model-library state from the app-level [`ModelsProvider`]. */
export function useModels(): ModelsValue {
  const ctx = useContext(ModelsContext);
  if (!ctx) throw new Error("useModels must be used within a ModelsProvider");
  return ctx;
}

/**
 * Fold an Ollama pull event into the download state. Ollama reports progress
 * per layer, so we surface the current layer's bytes as the progress bar — the
 * same approximation the `ollama pull` CLI shows.
 */
function applyProgress(cur: DownloadState, msg: PullProgress): DownloadState {
  const status = msg.status.toLowerCase();
  if (status.includes("success")) {
    return { ...cur, progress: 1, status: "verifying" };
  }
  if (status.startsWith("verif") || status.includes("writing manifest")) {
    return { ...cur, status: "verifying" };
  }
  if (msg.total && msg.completed != null) {
    return {
      ...cur,
      receivedBytes: msg.completed,
      progress: msg.total > 0 ? msg.completed / msg.total : cur.progress,
      status: "downloading",
    };
  }
  return { ...cur, status: "downloading" };
}
