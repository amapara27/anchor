import { useCallback, useEffect, useState } from "react";

const STORAGE_KEY = "anchor.favorites";

/** Read the persisted favorite ids, tolerating absent/corrupt storage. */
function readStored(): string[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    const parsed = raw ? JSON.parse(raw) : [];
    return Array.isArray(parsed) ? parsed.filter((x) => typeof x === "string") : [];
  } catch {
    return [];
  }
}

/**
 * Favorited model ids, persisted to localStorage. The registry doesn't track
 * favorites yet, so this is a frontend-only overlay (mirrors how tags/notes
 * stay session-local in `useModels`).
 */
export function useFavorites() {
  const [favorites, setFavorites] = useState<Set<string>>(() => new Set(readStored()));

  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify([...favorites]));
    } catch {
      // Storage may be unavailable (private mode); favorites stay in-memory.
    }
  }, [favorites]);

  const isFavorite = useCallback((id: string) => favorites.has(id), [favorites]);

  const toggleFavorite = useCallback((id: string) => {
    setFavorites((prev) => {
      const next = new Set(prev);
      next.has(id) ? next.delete(id) : next.add(id);
      return next;
    });
  }, []);

  return { favorites, isFavorite, toggleFavorite };
}
