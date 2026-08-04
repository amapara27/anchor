import type { PhaseMeta } from "../types";

/**
 * The Code Reviewer's phases, in lifecycle order. Kept out of `index.ts` so the
 * panel can import them without the cycle that entry ↔ panel would create.
 */
export const CODE_REVIEWER_PHASES: Record<string, PhaseMeta> = {
  scanning: {
    label: "Scanning",
    detail: "Walk the project for source files",
    color: "var(--accent-text)",
  },
  selecting: {
    label: "Selecting",
    detail: "Pick the files a newcomer must read",
    color: "var(--accent-text)",
  },
  reading: {
    label: "Reading",
    detail: "Load the code under review",
    color: "var(--accent)",
  },
  reviewing: {
    label: "Reviewing",
    detail: "Explain it, then flag bugs and optimizations",
    color: "var(--accent)",
  },
};

/** A single file or a pasted diff skips the walk and the selection generation. */
export const FILE_PHASES: Record<string, PhaseMeta> = {
  reading: CODE_REVIEWER_PHASES.reading,
  reviewing: CODE_REVIEWER_PHASES.reviewing,
};
