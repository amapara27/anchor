import type { ChatMessage as ChatMessageT, GenerationStats } from "../types";
import { formatTokSec, tokensPerSecond } from "../lib/format";
import { Markdown } from "./ui/Markdown";

/** Parse the persisted stats JSON back to a throughput figure, if present. */
function tokPerSec(stats_json: string | null): number | null {
  if (!stats_json) return null;
  try {
    return tokensPerSecond(JSON.parse(stats_json) as GenerationStats);
  } catch {
    return null;
  }
}

/**
 * One chat turn. User turns are plain text in a right-aligned bubble; assistant
 * turns render Markdown full-width with a tok/s footer. `streaming` shows the
 * blinking cursor on the in-progress assistant message.
 */
export function ChatMessage({ message, streaming }: { message: ChatMessageT; streaming?: boolean }) {
  if (message.role === "user") {
    return (
      <div className="flex justify-end">
        <div className="max-w-[80%] whitespace-pre-wrap rounded-2xl rounded-br-sm bg-accent/15 px-3.5 py-2 text-sm text-fg ring-1 ring-inset ring-accent/20">
          {message.content}
        </div>
      </div>
    );
  }

  const tok = tokPerSec(message.stats_json);
  return (
    <div className="flex flex-col gap-1">
      <div className="max-w-[85%]">
        <Markdown>{message.content}</Markdown>
        {streaming && (
          <span className="ml-0.5 inline-block h-4 w-1.5 animate-pulse bg-fg align-text-bottom" aria-hidden />
        )}
      </div>
      {tok != null && <span className="data text-[11px] text-fg-subtle">{formatTokSec(tok)}</span>}
    </div>
  );
}
