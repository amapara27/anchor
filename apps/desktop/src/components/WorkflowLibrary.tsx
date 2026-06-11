import type { WorkflowTemplate } from "../types";
import { TOOL_META, WORKFLOW_TEMPLATES } from "../lib/workflows";
import { PageHeader } from "./PageHeader";
import { PlayIcon, WorkflowIcon } from "./icons";

/** Library of agentic workflow templates. Mock data until `anchor-workflows` lands. */
export function WorkflowLibrary() {
  return (
    <div className="space-y-5">
      <PageHeader
        eyebrow="Automation"
        title="Workflow Library"
        subtitle="Tool-enabled templates that pin a model and wire up local capabilities."
      />

      <div className="stagger-children grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-3">
        {WORKFLOW_TEMPLATES.map((wf) => (
          <WorkflowCard key={wf.id} workflow={wf} />
        ))}
      </div>
    </div>
  );
}

function WorkflowCard({ workflow }: { workflow: WorkflowTemplate }) {
  return (
    <div className="card group flex flex-col p-4 transition-colors hover:border-slate-700">
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          <span className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-slate-800/80 text-emerald-400/90 ring-1 ring-slate-700/60">
            <WorkflowIcon className="size-4.5" />
          </span>
          <h3 className="truncate font-semibold text-slate-100">{workflow.name}</h3>
        </div>
        <span className="shrink-0 rounded-md bg-slate-800/60 px-2 py-1 font-mono text-[11px] text-slate-400 ring-1 ring-inset ring-slate-700/50">
          {workflow.model}
        </span>
      </div>

      <p className="mt-3 line-clamp-2 text-sm text-slate-400">{workflow.description}</p>

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

      <div className="mt-4 flex items-center gap-2 border-t border-slate-800/70 pt-3.5">
        <button
          type="button"
          disabled
          aria-disabled
          className="inline-flex cursor-not-allowed items-center gap-1.5 rounded-lg bg-emerald-500/80 px-2.5 py-1.5 text-xs font-semibold text-slate-950 opacity-50"
        >
          <PlayIcon className="size-3.5" /> Run
        </button>
        <span className="rounded-full bg-slate-800/60 px-2.5 py-1 text-[11px] font-medium text-slate-400 ring-1 ring-inset ring-slate-700/50">
          Coming soon
        </span>
      </div>
    </div>
  );
}
