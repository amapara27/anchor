import { useState } from "react";
import type { ChatMessage as ChatMessageT, GenerationStats } from "../types";
import { formatDuration, formatTokSec, tokensPerSecond } from "../lib/format";
import { Markdown } from "./ui/Markdown";
import { BranchIcon, ChevronRightIcon, ColumnsIcon, CopyIcon, RefreshIcon } from "./icons";

/** Parse the persisted stats JSON once; every footer figure derives from it. */
function parseStats(stats_json: string | null): GenerationStats | null {
  if (!stats_json) return null;
  try {
    return JSON.parse(stats_json) as GenerationStats;
  } catch {
    return null;
  }
}

/** The anchor mark that fronts every assistant turn. */
function AssistantAvatar() {
  return (
    <span className="mt-0.5 flex size-[26px] shrink-0 items-center justify-center rounded-[7px] border border-hair bg-accent-soft">
      <svg
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth={2}
        strokeLinecap="round"
        className="size-3.5 text-accent-text"
        aria-hidden
      >
        <circle cx="12" cy="3.6" r="2" />
        <path d="M12 5.6v15.2" />
        <path d="M8.2 8.6h7.6" />
        <path d="M3.5 12.9a8.5 8.5 0 0 0 8.5 7.9 8.5 8.5 0 0 0 8.5-7.9" />
      </svg>
    </span>
  );
}

/** Collapsible reasoning trace for thinking-capable models. */
function Reasoning({ text, live }: { text: string; live: boolean }) {
  const [open, setOpen] = useState(false);

  return (
    <div className="overflow-hidden rounded-[9px] border border-hair bg-inset">
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        aria-expanded={open}
        className="flex w-full cursor-pointer items-center gap-2 px-3 py-2 text-left transition-colors duration-150 ease-out hover:bg-hair focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/45"
      >
        <ChevronRightIcon
          className={`size-3 shrink-0 text-fg-subtle transition-transform duration-200 [transition-timing-function:var(--ease-out)] ${open ? "rotate-90" : ""}`}
        />
        <span className="data text-[11px] text-fg-muted">
          {live ? "Reasoning…" : `Reasoning · ${text.length.toLocaleString()} chars`}
        </span>
        <span className="data ml-auto text-[10.5px] text-fg-subtle">{open ? "hide" : "show"}</span>
      </button>
      {open && (
        <div className="whitespace-pre-wrap border-t border-hair px-3 pb-3 pl-[30px] pt-2.5 text-[12.5px] leading-[1.65] text-fg-muted">
          {text}
        </div>
      )}
    </div>
  );
}

/** One footer action. Unbacked ones render disabled rather than lying. */
function Action({
  label,
  Icon,
  onClick,
  disabled,
  title,
}: {
  label: string;
  Icon?: typeof CopyIcon;
  onClick?: () => void;
  disabled?: boolean;
  title?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      className="flex cursor-pointer items-center gap-1.5 rounded-[7px] border border-transparent px-2.5 py-1 text-[11.5px] text-fg-subtle transition-colors duration-150 ease-out hover:border-hair hover:bg-inset hover:text-fg focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/45 disabled:pointer-events-none disabled:opacity-40"
    >
      {Icon && <Icon className="size-3" />}
      {label}
    </button>
  );
}

/**
 * One chat turn. User turns are a right-aligned bubble; assistant turns render
 * as an avatar plus a body of typed Markdown blocks (see `ui/Markdown`) with a
 * throughput/actions footer. `streaming` marks the live turn.
 */
export function ChatMessage({ message, streaming }: { message: ChatMessageT; streaming?: boolean }) {
  const [copied, setCopied] = useState(false);

  if (message.role === "user") {
    return (
      <div className="flex justify-end">
        <div className="max-w-[76%] whitespace-pre-wrap rounded-[12px_12px_4px_12px] border border-hair bg-raised px-3.5 py-2.5 text-sm leading-[1.6] text-fg">
          {message.content}
        </div>
      </div>
    );
  }

  const stats = parseStats(message.stats_json);
  const tok = tokensPerSecond(stats ?? undefined);
  // Prompt eval is the wait before the first response token appears.
  const firstToken = stats?.prompt_eval_duration_ns;

  const copy = () => {
    navigator.clipboard.writeText(message.content).then(
      () => {
        setCopied(true);
        setTimeout(() => setCopied(false), 1400);
      },
      () => {},
    );
  };

  return (
    <div className="animate-fade-up flex gap-3">
      <AssistantAvatar />
      <div className="flex min-w-0 flex-1 flex-col gap-3.5">
        {message.thinking && <Reasoning text={message.thinking} live={!!streaming && !message.content} />}

        {message.content && <Markdown>{message.content}</Markdown>}

        {streaming ? (
          <span className="data flex items-center gap-2 text-[11px] text-fg-subtle">
            <span className="size-[5px] animate-pulse-dot rounded-full bg-accent-text" aria-hidden />
            generating
            <span className="animate-blink text-accent-text">▍</span>
          </span>
        ) : (
          stats && (
            <div className="flex flex-wrap items-center gap-3.5 border-t border-hair pt-3">
              <span className="data flex items-center gap-2 text-[11px] text-fg-subtle">
                {tok != null && (
                  <>
                    <span className="text-fg-muted">{formatTokSec(tok)}</span>
                    <span aria-hidden>·</span>
                  </>
                )}
                {stats.eval_count != null && (
                  <>
                    <span>{stats.eval_count.toLocaleString()} tokens</span>
                    <span aria-hidden>·</span>
                  </>
                )}
                <span>{formatDuration(firstToken)} to first token</span>
              </span>
              <div className="ml-auto flex gap-1">
                <Action label={copied ? "Copied" : "Copy"} Icon={CopyIcon} onClick={copy} />
                <Action label="Regenerate" Icon={RefreshIcon} disabled title="Not wired up yet" />
                <Action label="Branch" Icon={BranchIcon} disabled title="Not wired up yet" />
                <Action label="Compare model" Icon={ColumnsIcon} disabled title="Not wired up yet" />
              </div>
            </div>
          )
        )}
      </div>
    </div>
  );
}
