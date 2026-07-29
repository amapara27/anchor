import ReactMarkdown from "react-markdown";
import { openUrl } from "@tauri-apps/plugin-opener";
import type { Components } from "react-markdown";

/**
 * Renders assistant messages as Markdown with the app's Tailwind idiom. Raw HTML
 * stays disabled (no `rehype-raw`), so model output can't inject markup — the
 * only safe default for untrusted text.
 *
 * Inline code gets a subtle chip; fenced blocks render in a scrollable `bg-canvas`
 * panel (the `[&>code]` resets strip the inline chip off block code inside it).
 */
const COMPONENTS: Components = {
  a: ({ href, children }) => (
    <button
      type="button"
      onClick={() => href && openUrl(href).catch(() => {})}
      className="text-accent-text underline underline-offset-2 hover:opacity-80"
    >
      {children}
    </button>
  ),
  code: ({ children, className }) => (
    <code className={`rounded bg-surface-raised px-1 py-0.5 font-mono text-[0.85em] text-fg ${className ?? ""}`}>
      {children}
    </code>
  ),
  pre: ({ children }) => (
    <pre className="scrollbar-slim my-2 overflow-x-auto rounded-lg bg-canvas p-3 text-[0.85em] leading-relaxed [&>code]:bg-transparent [&>code]:p-0 [&>code]:text-fg">
      {children}
    </pre>
  ),
  ul: ({ children }) => <ul className="my-2 list-disc space-y-1 pl-5">{children}</ul>,
  ol: ({ children }) => <ol className="my-2 list-decimal space-y-1 pl-5">{children}</ol>,
  p: ({ children }) => <p className="my-2 first:mt-0 last:mb-0">{children}</p>,
  h1: ({ children }) => <h1 className="mb-2 mt-3 text-base font-semibold text-fg">{children}</h1>,
  h2: ({ children }) => <h2 className="mb-2 mt-3 text-base font-semibold text-fg">{children}</h2>,
  h3: ({ children }) => <h3 className="mb-1.5 mt-2.5 text-sm font-semibold text-fg">{children}</h3>,
  blockquote: ({ children }) => (
    <blockquote className="my-2 border-l-2 border-white/15 pl-3 text-fg-muted">{children}</blockquote>
  ),
};

export function Markdown({ children }: { children: string }) {
  return (
    <div className="text-sm leading-relaxed text-fg">
      <ReactMarkdown components={COMPONENTS}>{children}</ReactMarkdown>
    </div>
  );
}
