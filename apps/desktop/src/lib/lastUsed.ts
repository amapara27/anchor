// Local record of when each model was last used. Ollama doesn't track this, so
// we keep it per-machine in localStorage — a single JSON map of modelId → epoch ms.
const KEY = "anchor.lastUsed";

function readAll(): Record<string, number> {
  try {
    const raw = localStorage.getItem(KEY);
    return raw ? (JSON.parse(raw) as Record<string, number>) : {};
  } catch {
    return {}; // corrupt/unavailable storage must never break the app
  }
}

/** Stamp a model as used just now. */
export function recordUse(modelId: string): void {
  try {
    const all = readAll();
    all[modelId] = Date.now();
    localStorage.setItem(KEY, JSON.stringify(all));
  } catch {
    // best-effort: a failed write just means the model reads as "never used"
  }
}

/** Epoch ms of the last recorded use, or null if never used. */
export function getLastUsed(modelId: string): number | null {
  return readAll()[modelId] ?? null;
}
