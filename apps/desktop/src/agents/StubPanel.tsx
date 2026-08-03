/**
 * Placeholder panel for an agent whose executor isn't built yet.
 *
 * Never reachable in normal use — an entry with `ready: false` keeps its card's
 * "Spin up" disabled. It exists so every agent's `index.ts` can be complete and
 * registered from day one, which is what lets the registry stay frozen while
 * several agents are built in parallel.
 */
import { AgentHeader } from "./AgentShell";

export function StubPanel({ name, onBack }: { name: string; onBack: () => void }) {
  return (
    <div className="flex flex-col gap-6">
      <AgentHeader title={name} subtitle="This agent isn't built yet." onBack={onBack} />
      <p className="card px-4 py-10 text-center text-sm text-fg-subtle">
        No executor behind {name} yet.
      </p>
    </div>
  );
}
