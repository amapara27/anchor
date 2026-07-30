import { useEffect, useRef, useState } from "react";
import { CopyIcon } from "../icons";

/**
 * A fenced code block: header strip carrying the language and an optional file
 * path, plus a copy button, over a horizontally scrolling mono body.
 *
 * ponytail: no syntax highlighting. Colouring tokens needs shiki or prism —
 * a large dependency for something purely cosmetic. Swap the <code> body for a
 * highlighter's output if it ever matters more than bundle size.
 */
export function CodeBlock({
  code,
  language,
  filename,
}: {
  code: string;
  language?: string;
  filename?: string;
}) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);

  useEffect(() => () => clearTimeout(timer.current), []);

  const copy = () => {
    navigator.clipboard.writeText(code).then(
      () => {
        setCopied(true);
        clearTimeout(timer.current);
        timer.current = setTimeout(() => setCopied(false), 1400);
      },
      () => {}, // clipboard denied — leave the label alone
    );
  };

  return (
    <div className="overflow-hidden rounded-[var(--radius-card)] border border-hair bg-surface">
      <div className="flex items-center gap-2.5 border-b border-hair bg-inset px-3 py-1.5">
        {language && (
          <span className="data text-[10.5px] uppercase tracking-[0.05em] text-fg-subtle">{language}</span>
        )}
        {filename && <span className="data truncate text-[11.5px] text-fg-muted">{filename}</span>}
        <button
          type="button"
          onClick={copy}
          className={[
            "data ml-auto flex shrink-0 cursor-pointer items-center gap-1.5 rounded-md border border-hair px-2 py-0.5 text-[10.5px]",
            "transition-colors duration-150 ease-out hover:border-hair2 hover:text-fg",
            "focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/45",
            copied ? "text-ok" : "text-fg-muted",
          ].join(" ")}
        >
          <CopyIcon className="size-3" />
          {copied ? "Copied" : "Copy"}
        </button>
      </div>
      <pre className="scrollbar-slim overflow-x-auto px-3.5 py-3">
        <code className="data text-[12.5px] leading-[1.75] text-fg">{code}</code>
      </pre>
    </div>
  );
}
