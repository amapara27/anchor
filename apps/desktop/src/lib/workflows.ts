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
    id: "pdf-qa",
    name: "PDF Q&A",
    description: "Load a document and ask questions — answers are grounded in the file's contents.",
    model: "qwen2.5:14b",
    tools: ["file_reader"],
  },
  {
    id: "local-memory-chat",
    name: "Local Memory Chat",
    description: "A conversational assistant that remembers prior turns and facts across sessions.",
    model: "mistral:7b",
    tools: ["memory"],
  },
  {
    id: "code-reviewer",
    name: "Code Reviewer",
    description: "Reads a file or diff and returns focused feedback on bugs and clarity.",
    model: "qwen2.5-coder:7b",
    tools: ["file_reader"],
  },
  {
    id: "web-researcher",
    name: "Web Researcher",
    description: "Answers questions using live web search with linked sources.",
    model: "llama3.1:8b",
    tools: ["web_search"],
  },
  {
    id: "knowledge-base",
    name: "Knowledge Base",
    description: "Builds a searchable memory from your documents and answers from it on demand.",
    model: "qwen2.5:14b",
    tools: ["file_reader", "memory"],
  },
];

/** Category tag per template (frontend-only, like the templates themselves —
 *  kept out of `WorkflowTemplate`, which mirrors the Rust type). */
export const WORKFLOW_CATEGORY: Record<string, string> = {
  "research-assistant": "Research",
  "pdf-qa": "Docs",
  "local-memory-chat": "Chat",
  "code-reviewer": "Code",
  "web-researcher": "Research",
  "knowledge-base": "RAG",
};

/** Display label + icon for each tool, used by workflow cards. */
export const TOOL_META: Record<Tool, { label: string; Icon: typeof GlobeIcon }> = {
  web_search: { label: "Web Search", Icon: GlobeIcon },
  file_reader: { label: "File Reader", Icon: FileIcon },
  memory: { label: "Memory", Icon: BrainIcon },
};
