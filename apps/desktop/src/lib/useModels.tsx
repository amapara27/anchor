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

  // Models the user canceled tracking for: late-arriving pull events are ignored.
  const canceled = useRef<Set<string>>(new Set());

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

  const startDownload = useCallback(
    (model: LibraryModel) => {
      if (downloads[model.id]?.status === "downloading") return; // already running
      canceled.current.delete(model.id);
      setDownloads((d) => ({
        ...d,
        [model.id]: {
          modelId: model.id,
          progress: 0,
          receivedBytes: 0,
          status: "downloading",
        },
      }));

      const channel = new Channel<PullProgress>();
      channel.onmessage = (msg) => {
        if (canceled.current.has(model.id)) return;
        setDownloads((d) => {
          const cur = d[model.id];
          if (!cur) return d;
          return { ...d, [model.id]: applyProgress(cur, msg) };
        });
      };

      invoke("download_model", { id: model.id, onEvent: channel })
        .then(() => {
          if (canceled.current.has(model.id)) return;
          // Briefly show "done", then refresh from the backend so the model
          // flips to installed with its real on-disk specs.
          setDownloads((d) => {
            const cur = d[model.id];
            if (!cur) return d;
            return { ...d, [model.id]: { ...cur, progress: 1, status: "done" } };
          });
          window.setTimeout(() => {
            clearDownload(model.id);
            load();
          }, 400);
        })
        .catch((e) => {
          if (canceled.current.has(model.id)) return;
          setDownloads((d) => {
            const cur = d[model.id];
            if (!cur) return d;
            return { ...d, [model.id]: { ...cur, status: "error", error: String(e) } };
          });
        });
    },
    [downloads, load, clearDownload],
  );

  const cancelDownload = useCallback(
    (modelId: string) => {
      // Best-effort: stop tracking and clear the UI. The Ollama server may keep
      // pulling in the background — true server-side abort needs a cancel
      // command/abort handle (TODO).
      canceled.current.add(modelId);
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
