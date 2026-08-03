import type { AgentEntry } from "../types";
import { KnowledgeBasePanel } from "./Panel";
import { ASK_PHASES, INGEST_PHASES } from "./phases";

/**
 * Knowledge Base: several corpora, each with its own local model, answered from
 * embedded chunks only.
 *
 * Backend: `run_knowledge_base` / `kb_ingest` →
 * `anchor_workflows::agents::knowledge_base`, with documents and embedded chunks
 * in `kb_documents` / `kb_chunks` (schema V5).
 *
 * Both lifecycles are declared: the run inspector labels stored ingest phases
 * too, while the panel's stepper only walks the ask phases.
 */
const entry: AgentEntry = {
  id: "knowledge-base",
  Panel: KnowledgeBasePanel,
  ready: true,
  phases: { ...ASK_PHASES, ...INGEST_PHASES },
};

export default entry;
