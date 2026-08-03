import { ResearchAssistant } from "../../components/ResearchAssistant";
import type { AgentEntry } from "../types";
import { RESEARCH_PHASES } from "./phases";

/**
 * The Research Assistant, registered as-is.
 *
 * It predates the shared `AgentEvent` / `useAgent` contract and streams its own
 * richer `ResearchEvent`. Rewriting working, shipped code to converge them would
 * buy nothing, so the registry adapts to it rather than the other way round.
 */
const entry: AgentEntry = {
  id: "research-assistant",
  Panel: ResearchAssistant,
  ready: true,
  phases: RESEARCH_PHASES,
};

export default entry;
