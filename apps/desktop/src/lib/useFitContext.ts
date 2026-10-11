import { useSyncExternalStore } from "react";
import { DEFAULT_CONTEXT } from "./fit";

/** Contexts the Models header offers. Every fit verdict on Models is judged at the chosen one. */
export const FIT_CONTEXTS = [2048, 4096, 8192, 16384, 32768, 65536, 131072];

const STORAGE_KEY = "anchor.fitContext";

function read(): number {
  try {
    const n = Number(localStorage.getItem(STORAGE_KEY));
    return FIT_CONTEXTS.includes(n) ? n : DEFAULT_CONTEXT;
  } catch {
    return DEFAULT_CONTEXT;
  }
}

// ponytail: module-level store like useTheme — the header control, the rows and
// the inspector must agree, and this keeps them in sync without a provider.
let context = read();
const listeners = new Set<() => void>();

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function setFitContext(next: number) {
  context = next;
  try {
    localStorage.setItem(STORAGE_KEY, String(next));
  } catch {
    // Storage may be unavailable; the choice stays in-memory.
  }
  listeners.forEach((l) => l());
}

/** The context every Models fit verdict is judged at. */
export function useFitContext(): number {
  return useSyncExternalStore(subscribe, () => context);
}
