import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useChat } from "../lib/useChat";
import { useModels } from "../lib/useModels";
import { useHardwareProfile } from "../lib/useHardwareProfile";
import { ModelPicker } from "./ModelPicker";
import { ChatMessage } from "./ChatMessage";
import { ConfirmDialog } from "./ui/ConfirmDialog";
import { ChatIcon, CornerDownLeftIcon, TrashIcon } from "./icons";

/** A solid, widely-installed default (matches the Research Assistant's pick). */
const DEFAULT_MODEL = "llama3.1:8b";

/**
 * The Chat workspace: a conversation sidebar plus a streaming, multi-turn thread
 * over local Ollama models. Conversations persist in SQLite (via `useChat`); the
 * model picker surfaces the hardware fit hint — the moat — for the chosen model.
 */
export function ChatWorkspace() {
  const { models, loading } = useModels();
  const { profile } = useHardwareProfile();
  const { conversations, activeId, messages, running, error, select, create, remove, send } = useChat();

  const [model, setModel] = useState("");
  const [input, setInput] = useState("");
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);

  // Default the model once the library loads (prefer the suggested general one).
  useEffect(() => {
    if (model || models.length === 0) return;
    const suggested = models.find((m) => m.id === DEFAULT_MODEL);
    setModel(suggested?.id ?? models.find((m) => m.status === "installed")?.id ?? "");
  }, [models, model]);

  // Follow the active conversation's model when switching threads.
  const activeConvo = conversations.find((c) => c.id === activeId);
  useEffect(() => {
    if (activeConvo) setModel(activeConvo.model);
  }, [activeConvo?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const handleSend = async () => {
    const text = input.trim();
    if (!text || running || !model) return;
    setInput("");
    let id = activeId;
    if (!id) id = (await create(model)).id;
    send(id, model, text);
  };

  return (
    <div className="flex h-full">
      {/* Conversation sidebar */}
      <aside className="flex w-60 shrink-0 flex-col border-r border-white/8">
        <div className="p-3">
          <button
            type="button"
            onClick={() => create(model)}
            disabled={!model}
            className="flex w-full items-center justify-center gap-1.5 rounded-lg bg-accent px-3 py-2 text-sm font-medium text-accent-fg transition-colors hover:bg-accent/90 disabled:pointer-events-none disabled:opacity-40"
          >
            <span className="text-base leading-none">+</span> New chat
          </button>
        </div>
        <div className="scrollbar-slim min-h-0 flex-1 overflow-y-auto px-2 pb-3">
          {conversations.length === 0 ? (
            <p className="px-2 py-3 text-xs text-fg-subtle">No conversations yet.</p>
          ) : (
            conversations.map((c) => (
              <div
                key={c.id}
                className={[
                  "group flex items-center gap-1 rounded-lg px-2.5 py-2 text-sm transition-colors",
                  c.id === activeId ? "bg-surface-raised text-fg" : "text-fg-muted hover:bg-white/5",
                ].join(" ")}
              >
                <button
                  type="button"
                  onClick={() => select(c.id)}
                  className="min-w-0 flex-1 truncate text-left"
                  title={c.title}
                >
                  {c.title}
                </button>
                <button
                  type="button"
                  onClick={() => setPendingDelete(c.id)}
                  aria-label="Delete conversation"
                  className="shrink-0 text-fg-subtle opacity-0 transition-opacity hover:text-danger group-hover:opacity-100"
                >
                  <TrashIcon className="size-3.5" />
                </button>
              </div>
            ))
          )}
        </div>
      </aside>

      {/* Thread */}
      <section className="flex min-w-0 flex-1 flex-col">
        <div className="border-b border-white/8 px-5 py-3">
          <div className="max-w-xs">
            <ModelPicker
              label="Model"
              value={model}
              onChange={setModel}
              models={models}
              disabled={running || loading}
              profile={profile}
            />
          </div>
        </div>

        <MessageList messages={messages} running={running} error={error} />

        {/* Composer */}
        <div className="border-t border-white/8 px-5 py-3">
          <Composer value={input} onChange={setInput} onSend={handleSend} disabled={!model} running={running} />
        </div>
      </section>

      <ConfirmDialog
        open={pendingDelete !== null}
        title="Delete conversation?"
        body="This permanently removes the conversation and all its messages."
        confirmLabel="Delete"
        onConfirm={() => {
          if (pendingDelete) remove(pendingDelete);
          setPendingDelete(null);
        }}
        onCancel={() => setPendingDelete(null)}
      />
    </div>
  );
}

/** Scrolling message list that pins to the bottom as new tokens arrive. */
function MessageList({
  messages,
  running,
  error,
}: {
  messages: ReturnType<typeof useChat>["messages"];
  running: boolean;
  error?: string;
}) {
  const endRef = useRef<HTMLDivElement>(null);
  // Layout effect so the jump happens before paint (no visible flash).
  useLayoutEffect(() => {
    endRef.current?.scrollIntoView({ block: "end" });
  }, [messages]);

  if (messages.length === 0) {
    return (
      <div className="flex min-h-0 flex-1 flex-col items-center justify-center text-center">
        <span className="flex size-12 items-center justify-center rounded-full bg-white/5 text-accent-text ring-1 ring-inset ring-white/10">
          <ChatIcon className="size-6" />
        </span>
        <p className="mt-4 text-sm font-medium text-fg">Chat with your local models</p>
        <span className="mt-2 inline-flex items-center gap-1.5 text-[11px] text-fg-muted">
          <span className="size-1.5 rounded-full bg-ok" aria-hidden />
          This conversation never leaves your Mac
        </span>
      </div>
    );
  }

  return (
    <div className="scrollbar-slim min-h-0 flex-1 overflow-y-auto px-5 py-5">
      <div className="mx-auto flex max-w-2xl flex-col gap-5">
        {messages.map((m, i) => (
          <ChatMessage
            key={m.id}
            message={m}
            streaming={running && i === messages.length - 1 && m.role === "assistant"}
          />
        ))}
        {error && <p className="text-sm text-danger">{error}</p>}
        <div ref={endRef} />
      </div>
    </div>
  );
}

/** Auto-growing composer: Enter sends, Shift+Enter inserts a newline. */
function Composer({
  value,
  onChange,
  onSend,
  disabled,
  running,
}: {
  value: string;
  onChange: (v: string) => void;
  onSend: () => void;
  disabled: boolean;
  running: boolean;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);
  // Grow to fit content, capped so a long paste doesn't eat the thread.
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 200)}px`;
  }, [value]);

  return (
    <div className="mx-auto flex max-w-2xl items-end gap-2">
      <textarea
        ref={ref}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter" && !e.shiftKey) {
            e.preventDefault();
            onSend();
          }
        }}
        rows={1}
        placeholder="Message your local model…"
        className="scrollbar-slim max-h-52 flex-1 resize-none rounded-lg border border-white/8 bg-white/5 px-3.5 py-2.5 text-sm text-fg transition-colors placeholder:text-fg-subtle focus:border-accent/60 focus:outline-none focus:ring-2 focus:ring-accent/25"
      />
      <button
        type="button"
        onClick={onSend}
        disabled={disabled || running || !value.trim()}
        aria-label="Send message"
        className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-accent text-accent-fg transition-colors hover:bg-accent/90 disabled:pointer-events-none disabled:opacity-40"
      >
        <CornerDownLeftIcon className="size-4" />
      </button>
    </div>
  );
}
