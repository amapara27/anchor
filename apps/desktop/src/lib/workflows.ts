import type { Tool, WorkflowTemplate } from "../types";
import { BrainIcon, FileIcon, GlobeIcon } from "../components/icons";

/**
 * Example agentic workflows for the Workflow Library.
 *
 * Frontend-only stand-ins: `anchor-workflows` is a stub (`builtin_workflows()`
 * returns empty, no Tauri command exists yet), so these drive the UI until the
 * JSON template loader and tool executor land. When the backend arrives this
 * module is replaced by a `list_workflows` command.
 */
export const WORKFLOW_TEMPLATES: WorkflowTemplate[] = [
  {
    id: "research-assistant",
    name: "Research Assistant",
    description: "Searches the web, reads sources, and synthesizes a cited summary on any topic.",
    model: "llama3.1:8b",
    tools: ["web_search", "file_reader", "memory"],
  },
  {
    id: "knowledge-base",
    name: "Knowledge Base",
    description: "Builds a searchable memory from your documents and answers from it on demand.",
    model: "qwen2.5:14b",
    tools: ["file_reader", "memory"],
  },
  {
    id: "code-reviewer",
    name: "Code Reviewer",
    description: "Reads a file or diff and returns focused feedback on bugs and clarity.",
    model: "qwen2.5-coder:7b",
    tools: ["file_reader"],
  },
  {
    id: "batch-processor",
    name: "Batch Processor",
    description: "Applies one instruction across a folder of files and returns a row per file.",
    model: "qwen2.5:14b",
    tools: ["file_reader"],
  },
];

/** Category tag per template (frontend-only, like the templates themselves —
 *  kept out of `WorkflowTemplate`, which mirrors the Rust type). */
export const WORKFLOW_CATEGORY: Record<string, string> = {
  "research-assistant": "Research",
  "knowledge-base": "RAG",
  "code-reviewer": "Code",
  "batch-processor": "Docs",
};

/** Display label + icon for each tool, used by workflow cards. */
export const TOOL_META: Record<Tool, { label: string; Icon: typeof GlobeIcon }> = {
  web_search: { label: "Web Search", Icon: GlobeIcon },
  file_reader: { label: "File Reader", Icon: FileIcon },
  memory: { label: "Memory", Icon: BrainIcon },
};
