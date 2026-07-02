import { useEffect, useMemo, useRef, useState } from "react";
import type { Tab } from "../types";
import { useModels } from "../lib/useModels";
import { formatParams } from "../lib/format";
import { CornerDownLeftIcon, SearchIcon } from "./icons";

interface CommandPaletteProps {
  open: boolean;
  onClose: () => void;
  onNavigate: (tab: Tab) => void;
  /** Jump to a model: switch to the library and open its detail drawer. */
  onJumpToModel: (id: string) => void;
}

interface Command {
  id: string;
  label: string;
  hint?: string;
  run: () => void;
}

const PAGES: { tab: Tab; label: string }[] = [
  { tab: "home", label: "Home" },
  { tab: "search", label: "Discover" },
  { tab: "models", label: "Model Library" },
  { tab: "comparison", label: "Model Comparison" },
  { tab: "disk", label: "Disk Usage" },
  { tab: "workflows", label: "Workflow Library" },
];

/** ⌘K fuzzy launcher: jump to a model, run a comparison, or open any page. */
export function CommandPalette({ open, onClose, onNavigate, onJumpToModel }: CommandPaletteProps) {
  const { models } = useModels();
  const [query, setQuery] = useState("");
  const [active, setActive] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  const commands = useMemo<Command[]>(() => {
    const pages: Command[] = PAGES.map((p) => ({
      id: `page:${p.tab}`,
      label: `Go to ${p.label}`,
      hint: "Page",
      run: () => onNavigate(p.tab),
    }));
    const compare: Command = {
      id: "action:compare",
      label: "Run a comparison",
      hint: "Action",
      run: () => onNavigate("comparison"),
    };
    const modelCmds: Command[] = models.map((m) => ({
      id: `model:${m.id}`,
      label: m.name,
      hint: `${m.family} · ${formatParams(m.spec.params_b)}`,
      run: () => onJumpToModel(m.id),
    }));
    return [compare, ...pages, ...modelCmds];
  }, [models, onNavigate, onJumpToModel]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return commands
      .map((c) => ({ c, score: fuzzy(q, c.label) }))
      .filter((r): r is { c: Command; score: number } => r.score !== null)
      .sort((a, b) => b.score - a.score)
      .slice(0, 30)
      .map((r) => r.c);
  }, [commands, query]);

  // Reset on open + focus the input.
  useEffect(() => {
    if (open) {
      setQuery("");
      setActive(0);
      // focus after paint so the element exists
      requestAnimationFrame(() => inputRef.current?.focus());
    }
  }, [open]);

  useEffect(() => setActive(0), [query]);

  if (!open) return null;

  const run = (i: number) => {
    const cmd = filtered[i];
    if (!cmd) return;
    cmd.run();
    onClose();
  };

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center px-4 pt-[15vh]" role="dialog" aria-modal="true" aria-label="Command palette">
      <div className="absolute inset-0 bg-black/60" onClick={onClose} aria-hidden />
      <div
        className="relative flex w-full max-w-lg flex-col overflow-hidden rounded-[var(--radius-card)] border border-[var(--hairline-strong)] bg-surface shadow-overlay"
        onKeyDown={(e) => {
          if (e.key === "ArrowDown") {
            e.preventDefault();
            setActive((a) => Math.min(a + 1, filtered.length - 1));
          } else if (e.key === "ArrowUp") {
            e.preventDefault();
            setActive((a) => Math.max(a - 1, 0));
          } else if (e.key === "Enter") {
            e.preventDefault();
            run(active);
          } else if (e.key === "Escape") {
            e.preventDefault();
            onClose();
          }
        }}
      >
        <div className="flex items-center gap-2.5 border-b border-[var(--hairline)] px-4">
          <SearchIcon className="size-4 shrink-0 text-fg-subtle" />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Jump to a model, page, or action…"
            aria-label="Command palette search"
            className="w-full bg-transparent py-3.5 text-sm text-fg placeholder:text-fg-subtle focus:outline-none"
          />
        </div>

        <ul className="scrollbar-slim max-h-80 overflow-y-auto py-1.5">
          {filtered.length === 0 ? (
            <li className="px-4 py-6 text-center text-sm text-fg-subtle">No matches</li>
          ) : (
            filtered.map((c, i) => (
              <li key={c.id}>
                <button
                  type="button"
                  onMouseMove={() => setActive(i)}
                  onClick={() => run(i)}
                  className={[
                    "flex w-full items-center gap-3 px-4 py-2 text-left transition-colors duration-150 ease-out",
                    i === active ? "bg-surface-raised" : "",
                  ].join(" ")}
                >
                  <span className="data min-w-0 flex-1 truncate text-sm text-fg">{c.label}</span>
                  {c.hint && <span className="shrink-0 text-[11px] text-fg-subtle">{c.hint}</span>}
                  {i === active && <CornerDownLeftIcon className="size-3.5 shrink-0 text-fg-subtle" />}
                </button>
              </li>
            ))
          )}
        </ul>
      </div>
    </div>
  );
}

/**
 * Subsequence fuzzy score: higher is better, null when `text` doesn't contain
 * `query`'s chars in order. Empty query keeps everything (score 0).
 * ponytail: naive greedy match — fine for a few hundred commands.
 */
function fuzzy(query: string, text: string): number | null {
  if (!query) return 0;
  const t = text.toLowerCase();
  let ti = 0;
  let score = 0;
  let streak = 0;
  for (const ch of query) {
    const idx = t.indexOf(ch, ti);
    if (idx === -1) return null;
    streak = idx === ti ? streak + 1 : 0;
    score += idx === ti ? 2 + streak : -Math.min(idx - ti, 3);
    ti = idx + 1;
  }
  return score;
}
