import type { AgentEntry } from "../types";
import { StubPanel } from "../StubPanel";
import { BATCH_PROCESSOR_PHASES } from "./phases";

/**
 * Batch Processor: one extraction instruction applied across many files,
 * producing a row per file rather than prose.
 *
 * Backend: `run_batch_processor` → `anchor_workflows::agents::batch_processor`.
 */
const entry: AgentEntry = {
  id: "batch-processor",
  Panel: ({ onBack }) => StubPanel({ name: "Batch Processor", onBack }),
  ready: false,
  phases: BATCH_PROCESSOR_PHASES,
};

export default entry;
