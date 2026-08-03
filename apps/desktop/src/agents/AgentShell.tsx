/**
 * Chrome shared by every agent panel: the back bar, the form primitives, and a
 * phase stepper driven by the agent's own `phases` entry.
 *
 * Lifted out of `ResearchAssistant.tsx` so five panels share one set rather than
 * copy-pasting it five times.
 */
import type { ReactNode } from "react";
import { PageHeader } from "../components/PageHeader";
import { Button } from "../components/ui/Button";
import { CheckIcon } from "../components/icons";
import type { AgentState, PhaseMeta } from "./types";

export const INPUT_CLASS =
  "w-full rounded-lg border border-hair bg-inset px-3 py-2.5 text-sm text-fg transition-colors placeholder:text-fg-subtle focus:border-accent/60 focus:outline-none focus:ring-2 focus:ring-accent/25 disabled:opacity-60";

/** Labeled form row. */
export function Field({
  label,
  htmlFor,
  optional,
  note,
  children,
}: {
  label: string;
  htmlFor: string;
  optional?: boolean;
  note?: string;
  children: ReactNode;
}) {
  return (
    <div>
      <label htmlFor={htmlFor} className="mb-1.5 block label-caps">
        {label}
        {(optional || note) && (
          <span className="ml-1 normal-case text-fg-subtle">({optional ? "optional" : note})</span>
        )}
      </label>
      {children}
    </div>
  );
}

/** `border-t-current` rather than a fixed colour: this spins on a dark primary
 *  button and on the light card background, and must stay visible on both. */
export function Spinner({ small }: { small?: boolean }) {
  return (
    <span
      className={`${small ? "size-3 border" : "size-4 border-2"} animate-spin rounded-full border-hair2 border-t-current`}
      aria-hidden
    />
  );
}

/**
 * The back bar plus page header every agent panel opens with. `onReset` renders
 * the "start over" action once a run has happened.
 */
export function AgentHeader({
  title,
  subtitle,
  onBack,
  onReset,
  resetLabel,
  running,
  showReset,
}: {
  title: string;
  subtitle: string;
  onBack: () => void;
  onReset?: () => void;
  resetLabel?: string;
  running?: boolean;
  showReset?: boolean;
}) {
  return (
    <>
      <div className="flex items-center justify-between">
        <Button variant="text" onClick={onBack}>
          ← Agents
        </Button>
        {showReset && onReset && (
          <Button variant="ghost" onClick={onReset} disabled={running}>
            {resetLabel ?? "New run"}
          </Button>
        )}
      </div>
      <PageHeader eyebrow="Automation" title={title} subtitle={subtitle} />
    </>
  );
}

/**
 * Progress across an agent's phases, in the order its `phases` entry declares
 * them. A phase not in that map is skipped rather than rendered raw.
 */
export function PhaseStepper({
  phases,
  current,
}: {
  phases: Record<string, PhaseMeta>;
  current: AgentState["phase"];
}) {
  const order = Object.keys(phases);
  const at = order.indexOf(current);
  // `done` is not a declared phase, so it reads as "past every step".
  const finished = current === "done";

  return (
    <div className="flex flex-wrap items-center gap-2 text-xs">
      {order.map((key, i) => {
        const done = finished || at > i;
        const active = at === i && !finished;
        return (
          <div key={key} className="flex items-center gap-2">
            <span
              className={[
                "flex items-center gap-1.5 rounded-full px-2.5 py-1 font-medium ring-1 ring-inset",
                active
                  ? "bg-accent/15 text-accent-text ring-accent/40"
                  : done
                    ? "text-ok ring-ok/30"
                    : "text-fg-subtle ring-hair",
              ].join(" ")}
            >
              {active ? (
                <Spinner small />
              ) : done ? (
                <CheckIcon className="size-3" />
              ) : (
                <span className="size-1.5 rounded-full bg-current" />
              )}
              {phases[key].label}
            </span>
            {i < order.length - 1 && <span className="h-px w-4 bg-raised" />}
          </div>
        );
      })}
    </div>
  );
}
