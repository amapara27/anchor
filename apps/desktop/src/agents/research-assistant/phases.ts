import type { PhaseMeta } from "../types";

/**
 * The Research Assistant's lifecycle, in order.
 *
 * Its own file so both the registry entry and the panel can read it — the entry
 * imports the panel, so the panel cannot import the entry.
 */
export const RESEARCH_PHASES: Record<string, PhaseMeta> = {
  planning: {
    label: "Planning",
    detail: "Decompose the focus into search queries",
    color: "var(--accent-text)",
  },
  searching: {
    label: "Searching",
    detail: "Search the web and read sources",
    color: "var(--hair2)",
  },
  synthesizing: {
    label: "Synthesizing",
    detail: "Draft the cited brief",
    color: "var(--accent)",
  },
};
