import { StubPanel } from "../StubPanel";
import type { AgentEntry } from "../types";

/**
 * Code Reviewer. Owned by its worktree — flip `ready` to `true` and swap `Panel`
 * for the real one when the executor lands.
 *
 * Backend: `run_code_reviewer` → `anchor_workflows::agents::code_reviewer`.
 */
const entry: AgentEntry = {
  id: "code-reviewer",
  Panel: ({ onBack }) => StubPanel({ name: "Code Reviewer", onBack }),
  ready: false,
  phases: {
    reading: {
      label: "Reading",
      detail: "Load the file or diff under review",
      color: "var(--accent-text)",
    },
    reviewing: {
      label: "Reviewing",
      detail: "Draft findings on bugs and clarity",
      color: "var(--accent)",
    },
  },
};

export default entry;
