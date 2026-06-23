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
    <div className="card card-interactive group flex flex-col p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="flex min-w-0 items-center gap-3">
          <span className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-white/5 text-fg-muted ring-1 ring-inset ring-white/10">
            <WorkflowIcon className="size-4.5" />
          </span>
          <h3 className="truncate font-semibold text-fg">{workflow.name}</h3>
        </div>
        <span className="data shrink-0 rounded-md bg-white/5 px-2 py-1 text-[11px] text-fg-muted ring-1 ring-inset ring-white/10">
          {workflow.model}
        </span>
      </div>

      <p className="mt-3 line-clamp-2 text-sm text-fg-muted">{workflow.description}</p>

      <div className="mt-3 flex flex-wrap gap-1.5">
        {workflow.tools.map((tool) => {
          const { label, Icon } = TOOL_META[tool];
          return (
            <span
              key={tool}
              className="inline-flex items-center gap-1 rounded-md bg-white/5 px-2 py-0.5 text-[11px] font-medium text-fg-muted ring-1 ring-inset ring-white/10"
            >
              <Icon className="size-3" />
              {label}
            </span>
          );
        })}
      </div>

      <div className="mt-4 flex items-center gap-2 border-t border-white/8 pt-3.5">
        <button
          type="button"
          disabled
          aria-disabled
          className="inline-flex cursor-not-allowed items-center gap-1.5 rounded-lg bg-accent px-2.5 py-1.5 text-xs font-semibold text-accent-fg opacity-40"
        >
          <PlayIcon className="size-3.5" /> Run
        </button>
        <span className="inline-flex items-center gap-1.5 rounded-full bg-white/5 px-2.5 py-1 text-[11px] font-medium text-fg-muted ring-1 ring-inset ring-white/10">
          <span className="size-1.5 rounded-full bg-warn" aria-hidden />
          Coming soon
        </span>
      </div>
    </div>
  );
}
