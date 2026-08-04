import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { DEFAULT_PRESET_ID, type Preset } from "../types";

/** How long an edit sits before it's written, so a dragged slider is one write. */
const SAVE_DEBOUNCE_MS = 400;

/** A blank preset — every field null, i.e. "whatever Ollama defaults to". */
export function emptyPreset(name: string): Preset {
  return {
    id: crypto.randomUUID(),
    name,
    system: null,
    temperature: null,
    num_ctx: null,
    top_p: null,
    model: null,
    created_ms: Date.now(),
  };
}

/**
 * Owns the preset list: reads it from SQLite, and writes edits back through a
 * debounce so a stepper held down doesn't issue twenty round-trips.
 *
 * The list is optimistic — the UI shows the edit immediately and the write
 * follows — because a preset edit has no failure the user can act on beyond
 * "the DB is gone", at which point chat is broken anyway.
 */
export function usePresets() {
  const [presets, setPresets] = useState<Preset[]>([]);
  const [loading, setLoading] = useState(true);

  // Pending debounced writes, keyed by preset id, so edits to two different
  // presets can't cancel each other.
  const timers = useRef<Record<string, number>>({});

  const reload = useCallback(async () => {
    const list = await invoke<Preset[]>("list_presets").catch(() => [] as Preset[]);
    setPresets(list);
    setLoading(false);
    return list;
  }, []);

  useEffect(() => {
    reload();
  }, [reload]);

  /** Applies an edit locally, then writes it through after the debounce. */
  const save = useCallback((preset: Preset) => {
    setPresets((list) => {
      const at = list.findIndex((p) => p.id === preset.id);
      if (at < 0) return [...list, preset];
      return list.map((p) => (p.id === preset.id ? preset : p));
    });
    window.clearTimeout(timers.current[preset.id]);
    timers.current[preset.id] = window.setTimeout(() => {
      invoke("save_preset", { preset }).catch(() => {});
    }, SAVE_DEBOUNCE_MS);
  }, []);

  const create = useCallback(
    (name: string) => {
      const preset = emptyPreset(name);
      setPresets((list) => [...list, preset]);
      // Immediate write: a new row must exist before anything can point at it.
      invoke("save_preset", { preset }).catch(() => {});
      return preset;
    },
    [],
  );

  const remove = useCallback((id: string) => {
    if (id === DEFAULT_PRESET_ID) return; // protected backend-side too
    window.clearTimeout(timers.current[id]);
    setPresets((list) => list.filter((p) => p.id !== id));
    invoke("delete_preset", { id }).catch(() => {});
  }, []);

  // Flush nothing on unmount — a pending write would land after the component
  // is gone, and re-mounting reloads from the DB anyway. Instead, write straight
  // away when the page is hidden, which is the only way an edit gets lost.
  useEffect(() => {
    const flush = () => {
      for (const [id, timer] of Object.entries(timers.current)) {
        window.clearTimeout(timer);
        delete timers.current[id];
        const preset = presets.find((p) => p.id === id);
        if (preset) invoke("save_preset", { preset }).catch(() => {});
      }
    };
    window.addEventListener("beforeunload", flush);
    document.addEventListener("visibilitychange", flush);
    return () => {
      window.removeEventListener("beforeunload", flush);
      document.removeEventListener("visibilitychange", flush);
    };
  }, [presets]);

  return { presets, loading, reload, save, create, remove };
}
