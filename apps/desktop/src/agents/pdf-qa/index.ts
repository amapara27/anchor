import { StubPanel } from "../StubPanel";
import type { AgentEntry } from "../types";

/**
 * PDF Q&A. Owned by its worktree — flip `ready` to `true` and swap `Panel` for
 * the real one when the executor lands.
 *
 * Backend: `run_pdf_qa` → `anchor_workflows::agents::pdf_qa`.
 */
const entry: AgentEntry = {
  id: "pdf-qa",
  Panel: ({ onBack }) => StubPanel({ name: "PDF Q&A", onBack }),
  ready: false,
  phases: {
    reading: {
      label: "Reading",
      detail: "Extract the document's text",
      color: "var(--accent-text)",
    },
    answering: {
      label: "Answering",
      detail: "Answer from the document's contents",
      color: "var(--accent)",
    },
  },
};

export default entry;
