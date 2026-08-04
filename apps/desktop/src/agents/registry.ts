/**
 * Every agent the Agents page can launch, keyed by id.
 *
 * Frozen by design: each agent declares itself in its own `<id>/index.ts`, so
 * adding or finishing one never edits this file. That is what keeps several
 * agents mergeable when they are built in parallel.
 */
import type { AgentEntry, PhaseMeta } from "./types";

import batchProcessor from "./batch-processor";
import codeReviewer from "./code-reviewer";
import knowledgeBase from "./knowledge-base";
import researchAssistant from "./research-assistant";

const ENTRIES: AgentEntry[] = [researchAssistant, knowledgeBase, codeReviewer, batchProcessor];

export const AGENTS: Record<string, AgentEntry> = Object.fromEntries(
  ENTRIES.map((a) => [a.id, a]),
);

/** Whether an agent's card can actually be launched. */
export function isReady(id: string): boolean {
  return AGENTS[id]?.ready ?? false;
}

/**
 * How one phase of a stored run renders. Looks the phase up under the agent that
 * produced it, so two agents may reuse a phase name without colliding.
 */
export function phaseMeta(agentId: string, phase: string): PhaseMeta | undefined {
  return AGENTS[agentId]?.phases[phase];
}
