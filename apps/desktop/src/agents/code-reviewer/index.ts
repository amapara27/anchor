import type { AgentEntry } from "../types";
import { CodeReviewerPanel } from "./Panel";
import { CODE_REVIEWER_PHASES } from "./phases";

/**
 * Code Reviewer: points a local model at a codebase, a file, or a diff.
 *
 * Backend: `run_code_reviewer` → `anchor_workflows::agents::code_reviewer`.
 */
const entry: AgentEntry = {
  id: "code-reviewer",
  Panel: CodeReviewerPanel,
  ready: true,
  phases: CODE_REVIEWER_PHASES,
};

export default entry;
