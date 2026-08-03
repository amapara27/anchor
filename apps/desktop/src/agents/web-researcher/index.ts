import { StubPanel } from "../StubPanel";
import type { AgentEntry } from "../types";

/**
 * Web Researcher. Owned by its worktree — flip `ready` to `true` and swap
 * `Panel` for the real one when the executor lands.
 *
 * Backend: `run_web_researcher` → `anchor_workflows::agents::web_researcher`.
 */
const entry: AgentEntry = {
  id: "web-researcher",
  Panel: ({ onBack }) => StubPanel({ name: "Web Researcher", onBack }),
  ready: false,
  phases: {
    searching: {
      label: "Searching",
      detail: "Search the web and read sources",
      color: "var(--hair2)",
    },
    answering: {
      label: "Answering",
      detail: "Draft the answer with citations",
      color: "var(--accent)",
    },
  },
};

export default entry;
