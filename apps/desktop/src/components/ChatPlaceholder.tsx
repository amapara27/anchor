import { ChatIcon } from "./icons";

/** Placeholder for the Chat workspace — the front door, not yet wired to Ollama. */
export function ChatPlaceholder() {
  return (
    <div className="flex min-h-[60vh] flex-col items-center justify-center text-center">
      <span className="flex size-14 items-center justify-center rounded-full bg-white/5 text-accent-text ring-1 ring-inset ring-white/10">
        <ChatIcon className="size-7" />
      </span>
      <h2 className="mt-5 text-2xl font-semibold tracking-tight text-fg">Chat with your local models</h2>
      <p className="mt-2 max-w-sm text-sm text-fg-muted">
        A conversation with any model on this Mac is coming soon — hardware-aware, right from Anchor.
      </p>
      <span className="mt-5 inline-flex items-center gap-1.5 text-[11px] text-fg-muted">
        <span className="size-1.5 rounded-full bg-ok" aria-hidden />
        This conversation never leaves your Mac
      </span>
    </div>
  );
}
