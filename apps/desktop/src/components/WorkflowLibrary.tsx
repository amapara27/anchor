import type { WorkflowTemplate } from "../types";
import { TOOL_META, WORKFLOW_CATEGORY, WORKFLOW_TEMPLATES } from "../lib/workflows";
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
  const category = WORKFLOW_CATEGORY[workflow.id];
  return (
    <div className="card card-interactive group flex flex-col p-5">
      <div className="flex items-start justify-between gap-3">
        <span className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-white/5 text-fg-muted ring-1 ring-inset ring-white/10">
          <WorkflowIcon className="size-4.5" />
        </span>
        {category && (
          <span className="label-caps shrink-0 rounded-full bg-white/5 px-2 py-1 text-[10px] ring-1 ring-inset ring-white/10">
            {category}
          </span>
        )}
      </div>

      <h3 className="mt-3 truncate text-lg font-semibold text-fg">{workflow.name}</h3>
      <p className="mt-1.5 line-clamp-2 text-sm text-fg-muted">{workflow.description}</p>

      <div className="mt-4">
        <span className="label-caps text-[10px]">Required models</span>
        <div className="mt-1.5">
          <span className="data inline-flex items-center gap-1.5 rounded-md bg-white/5 px-2 py-1 text-[11px] text-fg-muted ring-1 ring-inset ring-white/10">
            {workflow.model}
          </span>
        </div>
      </div>

      <div className="mt-3 flex flex-wrap gap-1.5">
        {workflow.tools.map((tool) => {
          const { label, Icon } = TOOL_META[tool];
          return (
            <span
              key={tool}
              className="inline-flex items-center gap-1 rounded-full bg-white/5 px-2 py-0.5 text-[11px] font-medium text-fg-muted ring-1 ring-inset ring-white/10"
            >
              <Icon className="size-3" />
              {label}
            </span>
          );
        })}
      </div>

      {/* Footer: full-width ghost action, still honest about being a stub. */}
      <div className="mt-auto flex flex-col gap-2 border-t border-white/8 pt-4">
        <button
          type="button"
          disabled
          aria-disabled
          title="Workflows are coming soon"
          className="inline-flex w-full cursor-not-allowed items-center justify-center gap-1.5 rounded-lg border border-white/12 px-2.5 py-1.5 text-xs font-medium text-fg-muted opacity-50"
        >
          <PlayIcon className="size-3.5" /> Spin up
        </button>
        <span className="inline-flex items-center justify-center gap-1.5 text-[11px] font-medium text-fg-subtle">
          <span className="size-1.5 rounded-full bg-warn" aria-hidden />
          Coming soon
        </span>
      </div>
    </div>
  );
}
