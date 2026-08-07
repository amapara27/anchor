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

// ponytail: 30 days of no use marks a model stale. Bump if users hoard rarely-run models.
export const STALE_DAYS = 30;
const STALE_MS = STALE_DAYS * 86_400_000;

/**
 * Whether a model has gone unused long enough to be worth reclaiming.
 *
 * A model with no recorded use is judged on when it was *installed*, not treated
 * as stale outright: `recordUse` only started covering every run path recently,
 * and a model pulled this morning has legitimately never been run. Reporting
 * those as reclaimable is what put models a user relies on behind a one-click
 * "Select stale" → delete. With neither timestamp known, nothing is claimed.
 */
export function isStale(modelId: string, modifiedAt: string | null, now = Date.now()): boolean {
  const installed = modifiedAt ? Date.parse(modifiedAt) : NaN;
  const since = getLastUsed(modelId) ?? (Number.isNaN(installed) ? null : installed);
  return since != null && now - since > STALE_MS;
}
