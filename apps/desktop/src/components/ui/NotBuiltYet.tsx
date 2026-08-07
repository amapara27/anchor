import type { ReactNode } from "react";

/**
 * Placeholder for UI whose backend doesn't exist yet.
 *
 * Anchor's whole pitch is telling you the truth about your machine, so a screen
 * that shows a plausible-looking number it invented is worse than one that shows
 * nothing. Every one of these replaced sample data that read as real: dedupe
 * savings, a community leaderboard, preference toggles wired to nothing.
 *
 * `what` names the missing backend so the section still reads as a roadmap
 * rather than a bug.
 */
export function NotBuiltYet({ children, className = "" }: { children: ReactNode; className?: string }) {
  return (
    <div
      className={`flex flex-col gap-1.5 rounded-[9px] border border-dashed border-hair bg-inset px-3.5 py-3 ${className}`}
    >
      <span className="data self-start rounded-full border border-hair px-2 py-px text-[9.5px] uppercase tracking-[0.06em] text-fg-subtle">
        not built yet
      </span>
      <span className="text-[11.5px] leading-[1.5] text-fg-subtle">{children}</span>
    </div>
  );
}
