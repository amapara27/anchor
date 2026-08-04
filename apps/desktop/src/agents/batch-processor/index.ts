import type { AgentEntry } from "../types";
import { BatchProcessorPanel } from "./Panel";
import { BATCH_PROCESSOR_PHASES } from "./phases";

/**
 * Batch Processor: one extraction instruction applied across many files,
 * producing a row per file rather than prose.
 *
 * Backend: `run_batch_processor` → `anchor_workflows::agents::batch_processor`.
 */
const entry: AgentEntry = {
  id: "batch-processor",
  Panel: BatchProcessorPanel,
  ready: true,
  phases: BATCH_PROCESSOR_PHASES,
};

export default entry;
