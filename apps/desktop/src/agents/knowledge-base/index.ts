import { StubPanel } from "../StubPanel";
import type { AgentEntry } from "../types";

/**
 * Knowledge Base. Owned by its worktree — flip `ready` to `true` and swap
 * `Panel` for the real one when the executor lands.
 *
 * Backend: `run_knowledge_base` / `kb_ingest` →
 * `anchor_workflows::agents::knowledge_base`, with documents and embedded chunks
 * in `kb_documents` / `kb_chunks` (schema V5).
 */
const entry: AgentEntry = {
  id: "knowledge-base",
  Panel: ({ onBack }) => StubPanel({ name: "Knowledge Base", onBack }),
  ready: false,
  phases: {
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
  },
};

export default entry;
