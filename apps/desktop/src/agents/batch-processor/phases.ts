import type { PhaseMeta } from "../types";

/** Batch lifecycle — what `run_batch_processor` emits, in order. */
export const BATCH_PROCESSOR_PHASES: Record<string, PhaseMeta> = {
  reading: {
    label: "Reading",
    detail: "Extract text from every selected file",
    color: "var(--accent-text)",
  },
  extracting: {
    label: "Extracting",
    detail: "Fill the columns for one file at a time",
    color: "var(--accent)",
  },
};
