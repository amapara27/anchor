import type { WorkflowTemplate } from "../types";
import { TOOL_META, WORKFLOW_TEMPLATES } from "../lib/workflows";
import { PlayIcon } from "./icons";

/** Library of agentic workflow templates. Mock data until `anchor-workflows` lands. */
export function WorkflowLibrary() {
  return (
    <div className="space-y-5">
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold tracking-tight text-slate-50">Workflow Library</h1>
        <p className="text-sm text-slate-400">
          Tool-enabled templates that pin a model and wire up local capabilities.
        </p>
      </header>

      <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
        {WORKFLOW_TEMPLATES.map((wf) => (
          <WorkflowCard key={wf.id} workflow={wf} />
        ))}
      </div>
    </div>
  );
}

function WorkflowCard({ workflow }: { workflow: WorkflowTemplate }) {
  return (
    <div className="flex flex-col rounded-xl border border-slate-800 bg-slate-900/50 p-4">
      <div className="flex items-start justify-between gap-3">
        <h3 className="truncate font-semibold text-slate-100">{workflow.name}</h3>
        <span className="shrink-0 rounded-md bg-slate-800/40 px-2 py-1 font-mono text-[11px] text-slate-400">
          {workflow.model}
        </span>
      </div>

      <p className="mt-2 line-clamp-2 text-sm text-slate-400">{workflow.description}</p>

      <div className="mt-3 flex flex-wrap gap-1.5">
        {workflow.tools.map((tool) => {
          const { label, Icon } = TOOL_META[tool];
          return (
            <span
              key={tool}
              className="inline-flex items-center gap-1 rounded-md bg-emerald-500/10 px-2 py-0.5 text-[11px] font-medium text-emerald-300 ring-1 ring-inset ring-emerald-500/20"
            >
              <Icon className="size-3" />
              {label}
            </span>
          );
        })}
      </div>

      <div className="mt-4 flex items-center gap-2">
        <button
          type="button"
          disabled
          aria-disabled
          className="inline-flex cursor-not-allowed items-center gap-1.5 rounded-lg bg-emerald-500/90 px-2.5 py-1.5 text-xs font-semibold text-slate-950 opacity-60"
        >
          <PlayIcon className="size-3.5" /> Run
        </button>
        <span className="text-xs text-slate-500">Coming soon</span>
      </div>
    </div>
  );
}
