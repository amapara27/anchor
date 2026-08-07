import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { QueryRecord, ScoredModel } from "../types";

/** How many models a search returns (the user wants the top 3). */
const SEARCH_LIMIT = 3;
/** How many distinct recent queries to surface as chips. */
const RECENTS_SHOWN = 6;
/**
 * Below this top cosine score the results are too weak to present as confident
 * "AI matches"; the UI falls back to a "related models" browse instead.
 *
 * Calibrated against the real corpus rather than guessed: BGE-small puts even
 * unrelated pairs around 0.62 here — "translate text between languages", which
 * this catalog has no model for, scored 0.630/0.628/0.623 on three *embedding*
 * models — while genuine matches land at 0.72+ ("generate embeddings for a RAG
 * pipeline" → 0.735 all-minilm). The old 0.35 sat below the noise floor, so
 * every query read as confident, including the ones with nothing to match.
 *
 * ponytail: a single tuned threshold, not a per-capability curve. Re-measure it
 * if the catalog or the embedding model changes.
 */
const CONFIDENCE_THRESHOLD = 0.68;

export type SearchStatus = "idle" | "searching" | "ready" | "error";

/**
 * The shape the Discover page consumes. `search_models` returns the ranked
 * (already capability-filtered) hits; `confident` is derived here from the top
 * score so the raw cosine number never has to reach the UI. Defined locally
 * (not in the frozen `types.ts`) since it's search-internal.
 */
export interface SearchResponse {
  models: ScoredModel[];
  confident: boolean;
}

/**
 * Owns the Discover page's semantic search: runs `search_models`, tracks the
 * last submitted query for the results heading, and keeps the recent-query list
 * fresh from the backend's history store. Mirrors `useComparison`'s channel/run
 * idioms — a `runId` ref drops results from a superseded search.
 */
export function useModelSearch() {
  const [results, setResults] = useState<ScoredModel[]>([]);
  const [confident, setConfident] = useState(true);
  const [status, setStatus] = useState<SearchStatus>("idle");
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [recents, setRecents] = useState<string[]>([]);

  const runId = useRef(0);

  const loadRecents = useCallback(() => {
    invoke<QueryRecord[]>("recent_searches", { limit: 10 })
      .then((records) => {
        // De-dupe by query text (keep most recent), then cap.
        const seen = new Set<string>();
        const unique: string[] = [];
        for (const r of records) {
          if (seen.has(r.query)) continue;
          seen.add(r.query);
          unique.push(r.query);
          if (unique.length >= RECENTS_SHOWN) break;
        }
        setRecents(unique);
      })
      .catch(() => setRecents([])); // history is best-effort; absence is fine
  }, []);

  useEffect(() => {
    loadRecents();
  }, [loadRecents]);

  const search = useCallback(
    (q: string) => {
      const trimmed = q.trim();
      if (!trimmed) return;
      const myRun = ++runId.current;
      setQuery(trimmed);
      setStatus("searching");
      setError(null);

      invoke<ScoredModel[]>("search_models", { query: trimmed, limit: SEARCH_LIMIT })
        .then((hits) => {
          if (runId.current !== myRun) return; // superseded by a newer search
          setResults(hits);
          setConfident((hits[0]?.score ?? 0) >= CONFIDENCE_THRESHOLD);
          setStatus("ready");
          // The backend just recorded this query — refresh the chips.
          loadRecents();
        })
        .catch((e) => {
          if (runId.current !== myRun) return;
          // Surfaces the backend's "still warming up — try again" message too.
          setError(String(e));
          setStatus("error");
        });
    },
    [loadRecents],
  );

  return { results, confident, status, error, query, recents, search };
}
