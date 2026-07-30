import { useCallback, useSyncExternalStore } from "react";

/** What the user picked. `system` follows the OS appearance live. */
export type ThemePref = "dark" | "light" | "system";
/** What actually renders — what `data-theme` on <html> is set to. */
export type Theme = "dark" | "light";

const STORAGE_KEY = "anchor.theme";
const DARK_QUERY = "(prefers-color-scheme: dark)";

function readPref(): ThemePref {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    return raw === "dark" || raw === "light" || raw === "system" ? raw : "dark";
  } catch {
    return "dark";
  }
}

function resolve(pref: ThemePref): Theme {
  if (pref !== "system") return pref;
  return window.matchMedia(DARK_QUERY).matches ? "dark" : "light";
}

// ponytail: module-level store via useSyncExternalStore instead of a context
// provider — the titlebar toggle and the Settings picker must agree, and this
// is the smallest thing that keeps them in sync without threading a provider.
let pref: ThemePref = readPref();
const listeners = new Set<() => void>();

/** Writes `data-theme` on <html> — the attribute `styles.css` keys its token
 *  overrides off, so every utility re-resolves without a React re-render. */
function apply() {
  document.documentElement.dataset.theme = resolve(pref);
  listeners.forEach((l) => l());
}

apply();
window.matchMedia(DARK_QUERY).addEventListener("change", () => {
  if (pref === "system") apply();
});

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** App appearance: the stored preference plus the theme it resolves to. */
export function useTheme() {
  const current = useSyncExternalStore(subscribe, () => pref);

  const setPref = useCallback((next: ThemePref) => {
    pref = next;
    try {
      localStorage.setItem(STORAGE_KEY, next);
    } catch {
      // Storage may be unavailable; the choice stays in-memory.
    }
    apply();
  }, []);

  const theme = resolve(current);
  const toggle = useCallback(() => setPref(resolve(pref) === "dark" ? "light" : "dark"), [setPref]);

  return { pref: current, theme, setPref, toggle };
}
