import type { PhaseMeta } from "../types";

/** Ingest lifecycle — what `kb_ingest` emits, in order. */
export const INGEST_PHASES: Record<string, PhaseMeta> = {
  reading: {
    label: "Reading",
    detail: "Extract the document's text and split it into chunks",
    color: "var(--accent-text)",
  },
  embedding: {
    label: "Embedding",
    detail: "Turn every chunk into a vector and store it",
    color: "var(--accent)",
  },
};

/** Ask lifecycle — what `run_knowledge_base` emits, in order. */
export const ASK_PHASES: Record<string, PhaseMeta> = {
  retrieving: {
    label: "Retrieving",
    detail: "Find the passages closest to the question",
    color: "var(--accent-text)",
  },
  answering: {
    label: "Answering",
    detail: "Answer from the retrieved passages",
    color: "var(--accent)",
  },
};
