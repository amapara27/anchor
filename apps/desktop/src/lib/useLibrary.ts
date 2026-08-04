import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { LibraryEntry, LibraryTag } from "../types";

export type LibraryStatus = "loading" | "ready" | "error";

/**
 * The full public Ollama library — every installable model, not just the 38
 * curated profiles Discover's semantic search ranks.
 *
 * The backend serves this from a day-old SQLite cache and only re-scrapes when
 * it's stale, so mounting this is usually free. Tag lists are fetched per model
 * on expand and memoised for the session; nothing prefetches them, since a
 * popular model has ~90 tags and nobody opens more than a couple.
 */
export function useLibrary() {
  const [entries, setEntries] = useState<LibraryEntry[]>([]);
  const [status, setStatus] = useState<LibraryStatus>("loading");
  const [error, setError] = useState<string | null>(null);
  const [tags, setTags] = useState<Record<string, LibraryTag[]>>({});
  const [loadingTags, setLoadingTags] = useState<Record<string, boolean>>({});

  const load = useCallback((refresh = false) => {
    setStatus("loading");
    invoke<LibraryEntry[]>("list_library", { refresh })
      .then((list) => {
        setEntries(list);
        setStatus("ready");
        setError(null);
      })
      .catch((e) => {
        setError(String(e));
        setStatus("error");
      });
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const loadTags = useCallback(
    (name: string) => {
      if (tags[name] || loadingTags[name]) return; // already have them / in flight
      setLoadingTags((t) => ({ ...t, [name]: true }));
      invoke<LibraryTag[]>("library_tags", { name })
        .then((list) => setTags((t) => ({ ...t, [name]: list })))
        // A failed tag fetch leaves the row expandable again rather than
        // caching an empty list as if the model had no tags.
        .catch(() => {})
        .finally(() => setLoadingTags((t) => ({ ...t, [name]: false })));
    },
    [tags, loadingTags],
  );

  return { entries, status, error, tags, loadingTags, reload: load, loadTags };
}
