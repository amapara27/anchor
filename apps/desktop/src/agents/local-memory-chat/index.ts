import { StubPanel } from "../StubPanel";
import type { AgentEntry } from "../types";

/**
 * Local Memory Chat. Owned by its worktree — flip `ready` to `true` and swap
 * `Panel` for the real one when the executor lands.
 *
 * Backend: `run_memory_chat` → `anchor_workflows::agents::memory_chat`, with
 * facts in `agent_memory` (schema V5).
 */
const entry: AgentEntry = {
  id: "local-memory-chat",
  Panel: ({ onBack }) => StubPanel({ name: "Local Memory Chat", onBack }),
  ready: false,
  phases: {
    recalling: {
      label: "Recalling",
      detail: "Pull remembered facts for this scope",
      color: "var(--accent-text)",
    },
    answering: {
      label: "Answering",
      detail: "Reply with that context in mind",
      color: "var(--accent)",
    },
    remembering: {
      label: "Remembering",
      detail: "Extract new facts worth keeping",
      color: "var(--hair2)",
    },
  },
};

export default entry;
