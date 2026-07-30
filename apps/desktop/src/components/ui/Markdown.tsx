import { Children, isValidElement, type ReactNode } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { openUrl } from "@tauri-apps/plugin-opener";
import { CodeBlock } from "./CodeBlock";

/**
 * Renders assistant messages as Markdown with a distinct visual treatment per
 * block type — code fences, tables, callouts, and lists each get their own
 * chrome rather than all reading as one undifferentiated wall of prose.
 *
 * Raw HTML stays disabled (no `rehype-raw`), so model output can't inject
 * markup — the only safe default for untrusted text. GFM is on for tables,
 * strikethrough and task lists.
 */

/** Pull the raw text back out of a `<pre>`'s child `<code>` element. */
function textOf(node: ReactNode): string {
  if (typeof node === "string") return node;
  if (typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textOf).join("");
  if (isValidElement<{ children?: ReactNode }>(node)) return textOf(node.props.children);
  return "";
}

/** `language-rust` → `rust`; a `rust:path/to/file.rs` fence also yields a name. */
function fenceInfo(node: ReactNode): { language?: string; filename?: string } {
  const child = Children.toArray(node)[0];
  if (!isValidElement<{ className?: string }>(child)) return {};
  const match = /language-([^\s]+)/.exec(child.props.className ?? "");
  if (!match) return {};
  const [language, filename] = match[1].split(/[:#]/);
  return { language, filename };
}

const COMPONENTS: Components = {
  a: ({ href, children }) => (
    <button
      type="button"
      onClick={() => href && openUrl(href).catch(() => {})}
      className="cursor-pointer text-accent-text underline underline-offset-2 hover:opacity-80"
    >
      {children}
    </button>
  ),

  // Inline code — a bordered chip. Fenced blocks are intercepted by `pre`
  // below, so this only ever renders the inline case.
  code: ({ children, className }) => (
    <code
      className={`data rounded-[5px] border border-hair bg-inset px-1.5 py-px text-[0.88em] text-fg ${className ?? ""}`}
    >
      {children}
    </code>
  ),

  // Fenced block → the full code panel with language header and copy button.
  pre: ({ children }) => {
    const { language, filename } = fenceInfo(children);
    return <CodeBlock code={textOf(children).replace(/\n$/, "")} language={language} filename={filename} />;
  },

  // Blockquote → the design's callout card.
  blockquote: ({ children }) => (
    <div className="flex flex-col gap-1.5 rounded-[9px] border border-hair bg-inset px-3.5 py-3">
      <span className="data text-[10px] uppercase tracking-[0.07em] text-warn">Note</span>
      <div className="text-[13.5px] leading-[1.6] text-fg-muted">{children}</div>
    </div>
  ),

  // Tables → bordered card with a mono caps header row.
  table: ({ children }) => (
    <div className="scrollbar-slim overflow-x-auto rounded-[var(--radius-card)] border border-hair">
      <table className="w-full border-collapse text-[13px]">{children}</table>
    </div>
  ),
  thead: ({ children }) => <thead className="bg-inset">{children}</thead>,
  tr: ({ children }) => <tr className="border-t border-hair first:border-t-0">{children}</tr>,
  th: ({ children }) => (
    <th className="data px-3 py-2 text-left text-[10.5px] font-semibold uppercase tracking-[0.05em] text-fg-subtle">
      {children}
    </th>
  ),
  td: ({ children }) => <td className="px-3 py-2.5 align-top text-fg-muted">{children}</td>,

  // Lists — a leading <strong> term reads as the label, the body stays muted.
  ul: ({ children }) => (
    <ul className="flex list-disc flex-col gap-1 pl-5 text-[14px] leading-[1.7] text-fg-muted">{children}</ul>
  ),
  ol: ({ children }) => (
    <ol className="flex list-decimal flex-col gap-1 pl-5 text-[14px] leading-[1.7] text-fg-muted">{children}</ol>
  ),
  strong: ({ children }) => <strong className="font-semibold text-fg">{children}</strong>,

  p: ({ children }) => <p className="text-[14.5px] leading-[1.68] [text-wrap:pretty]">{children}</p>,
  h1: ({ children }) => <h3 className="text-[15px] font-semibold tracking-tight text-fg">{children}</h3>,
  h2: ({ children }) => <h4 className="text-[14px] font-semibold tracking-tight text-fg">{children}</h4>,
  h3: ({ children }) => <h4 className="text-[13px] font-semibold tracking-[0.01em] text-fg">{children}</h4>,
  h4: ({ children }) => <h5 className="text-[13px] font-semibold tracking-[0.01em] text-fg">{children}</h5>,
  hr: () => <hr className="border-hair" />,
};

export function Markdown({ children }: { children: string }) {
  // The flex column is what gives every block the design's uniform rhythm,
  // instead of each element carrying its own margins.
  return (
    <div className="flex min-w-0 flex-col gap-3.5 text-fg [&_li>p]:m-0 [&_p]:m-0">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={COMPONENTS}>
        {children}
      </ReactMarkdown>
    </div>
  );
}
