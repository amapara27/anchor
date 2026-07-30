import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { Conversation, GenerationStats } from "../types";
import { useChat } from "../lib/useChat";
import { useModels } from "../lib/useModels";
import { useHardwareProfile } from "../lib/useHardwareProfile";
import { formatContext } from "../lib/format";
import { DEFAULT_CONTEXT } from "../lib/fit";
import { ModelSelect } from "./ui/ModelSelect";
import { Meter } from "./ui/SegmentedBar";
import { ChatMessage } from "./ChatMessage";
import { ConfirmDialog } from "./ui/ConfirmDialog";
import { PencilIcon, PlusIcon, SearchIcon, SendIcon, TrashIcon } from "./icons";

/** A solid, widely-installed default (matches the Research Assistant's pick). */
const DEFAULT_MODEL = "llama3.1:8b";

const DAY_MS = 86_400_000;

/** Bucket conversations by recency — the design's Today / Earlier headings. */
function groupConversations(list: Conversation[]) {
  const now = Date.now();
  const groups: { label: string; items: Conversation[] }[] = [
    { label: "Today", items: [] },
    { label: "Earlier this week", items: [] },
    { label: "Older", items: [] },
  ];
  for (const c of list) {
    const age = now - c.updated_ms;
    const bucket = age < DAY_MS ? 0 : age < 7 * DAY_MS ? 1 : 2;
    groups[bucket].items.push(c);
  }
  return groups.filter((g) => g.items.length > 0);
}

/**
 * The Chat workspace: a conversation rail, a streaming thread over local Ollama
 * models, and a composer. Conversations persist in SQLite (via `useChat`); the
 * model pill surfaces the hardware fit hint — the moat — for the chosen model.
 */
export function ChatWorkspace() {
  const { models, loading } = useModels();
  const { profile } = useHardwareProfile();
  const { conversations, activeId, messages, running, error, select, create, rename, remove, send } = useChat();

  const [model, setModel] = useState("");
  const [input, setInput] = useState("");
  const [query, setQuery] = useState("");
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);
  const [renamingId, setRenamingId] = useState<string | null>(null);

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

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return q ? conversations.filter((c) => c.title.toLowerCase().includes(q)) : conversations;
  }, [conversations, query]);

  const groups = useMemo(() => groupConversations(filtered), [filtered]);

  const handleSend = async () => {
    const text = input.trim();
    if (!text || running || !model) return;
    setInput("");
    let id = activeId;
    if (!id) id = (await create(model)).id;
    send(id, model, text);
  };

  return (
    <div className="flex min-w-0 flex-1">
      {/* Conversation rail */}
      <aside className="flex w-[262px] shrink-0 flex-col border-r border-hair bg-chrome">
        <div className="flex flex-col gap-2.5 border-b border-hair px-3 py-3.5">
          <button
            type="button"
            onClick={() => create(model)}
            disabled={!model}
            className="flex h-8 cursor-pointer items-center justify-center gap-2 rounded-lg bg-accent text-[13px] font-semibold text-accent-fg transition-[filter,transform] duration-150 ease-out hover:brightness-110 active:scale-[0.985] disabled:pointer-events-none disabled:opacity-40"
          >
            <PlusIcon className="size-3.5" />
            New chat
          </button>
          <label className="flex h-[30px] items-center gap-2 rounded-lg border border-hair bg-inset px-2.5">
            <SearchIcon className="size-3.5 shrink-0 text-fg-subtle" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search conversations"
              aria-label="Search conversations"
              className="min-w-0 flex-1 bg-transparent text-[12.5px] text-fg placeholder:text-fg-subtle focus:outline-none"
            />
          </label>
        </div>

        <div className="scrollbar-slim min-h-0 flex-1 overflow-y-auto px-2 py-2.5">
          {groups.length === 0 ? (
            <p className="px-2 py-3 text-[11.5px] leading-relaxed text-fg-subtle">
              {conversations.length === 0 ? "No conversations yet." : "No conversations match that search."}
            </p>
          ) : (
            groups.map((group) => (
              <div key={group.label} className="mb-3.5">
                <span className="label-caps block px-1.5 pb-1.5">{group.label}</span>
                {group.items.map((c) => (
                  <ConversationRow
                    key={c.id}
                    convo={c}
                    active={c.id === activeId}
                    renaming={renamingId === c.id}
                    onOpen={() => select(c.id)}
                    onStartRename={() => setRenamingId(c.id)}
                    onCommitRename={(title) => {
                      if (title.trim()) rename(c.id, title.trim());
                      setRenamingId(null);
                    }}
                    onDelete={() => setPendingDelete(c.id)}
                  />
                ))}
              </div>
            ))
          )}
          <p className="px-2 text-[11.5px] leading-[1.5] text-fg-subtle">
            Double-click a conversation to rename it. History is stored in a local SQLite file.
          </p>
        </div>
      </aside>

      {/* Thread */}
      <section className="flex min-h-0 min-w-0 flex-1 flex-col">
        <ThreadHeader
          convo={activeConvo}
          messages={messages}
          model={model}
          onModelChange={setModel}
          models={models}
          profile={profile}
          pickerDisabled={running || loading}
          onRename={(title) => activeConvo && rename(activeConvo.id, title)}
        />

        <MessageList messages={messages} running={running} error={error} />

        <div className="shrink-0 border-t border-hair bg-canvas px-6 pb-[18px] pt-3.5">
          <Composer value={input} onChange={setInput} onSend={handleSend} disabled={!model} running={running} />
          <p className="data mx-auto mt-2.5 flex max-w-[760px] items-center gap-2 text-[10.5px] text-fg-subtle">
            <span className="size-[5px] rounded-full bg-ok" aria-hidden />
            This conversation never leaves this Mac
          </p>
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

/** One row in the conversation rail; double-click swaps in an inline editor. */
function ConversationRow({
  convo,
  active,
  renaming,
  onOpen,
  onStartRename,
  onCommitRename,
  onDelete,
}: {
  convo: Conversation;
  active: boolean;
  renaming: boolean;
  onOpen: () => void;
  onStartRename: () => void;
  onCommitRename: (title: string) => void;
  onDelete: () => void;
}) {
  const [draft, setDraft] = useState(convo.title);

  useEffect(() => setDraft(convo.title), [convo.title, renaming]);

  return (
    <div
      onClick={onOpen}
      onDoubleClick={onStartRename}
      className={[
        "group flex cursor-pointer flex-col gap-1 rounded-lg px-2.5 py-2 transition-colors duration-150 ease-out",
        active ? "bg-raised shadow-[inset_2px_0_0_var(--accent)]" : "hover:bg-inset",
      ].join(" ")}
    >
      {renaming ? (
        <input
          autoFocus
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onBlur={() => onCommitRename(draft)}
          onKeyDown={(e) => {
            if (e.key === "Enter") e.currentTarget.blur();
            if (e.key === "Escape") onCommitRename(convo.title);
          }}
          onClick={(e) => e.stopPropagation()}
          className="w-full rounded-md border border-accent-line bg-surface px-1.5 py-0.5 text-[13px] font-semibold text-fg focus:outline-none"
        />
      ) : (
        <span className="flex min-w-0 items-center gap-1.5">
          <span
            className={`min-w-0 flex-1 truncate text-[13px] font-medium ${active ? "text-fg" : "text-fg-muted"}`}
            title={convo.title}
          >
            {convo.title}
          </span>
          <button
            type="button"
            onClick={(e) => {
              e.stopPropagation();
              onDelete();
            }}
            aria-label="Delete conversation"
            className="shrink-0 cursor-pointer text-fg-subtle opacity-0 transition-opacity hover:text-danger focus:opacity-100 group-hover:opacity-100"
          >
            <TrashIcon className="size-3.5" />
          </button>
        </span>
      )}
      <span className="data flex items-center gap-1.5 text-[10px] text-fg-subtle">
        <span className="truncate">{convo.model}</span>
      </span>
    </div>
  );
}

/** Title (click to rename), model pill, and the live context meter. */
function ThreadHeader({
  convo,
  messages,
  model,
  onModelChange,
  models,
  profile,
  pickerDisabled,
  onRename,
}: {
  convo: Conversation | undefined;
  messages: ReturnType<typeof useChat>["messages"];
  model: string;
  onModelChange: (id: string) => void;
  models: ReturnType<typeof useModels>["models"];
  profile: ReturnType<typeof useHardwareProfile>["profile"];
  pickerDisabled: boolean;
  onRename: (title: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState("");

  // Context use: the newest turn's prompt + response is what the model holds.
  const contextTokens = useMemo(() => {
    for (let i = messages.length - 1; i >= 0; i--) {
      const raw = messages[i].stats_json;
      if (!raw) continue;
      try {
        const s = JSON.parse(raw) as GenerationStats;
        return (s.prompt_eval_count ?? 0) + (s.eval_count ?? 0);
      } catch {
        return null;
      }
    }
    return null;
  }, [messages]);

  const turns = messages.filter((m) => m.role === "user").length;

  return (
    <div className="flex shrink-0 items-center gap-3 border-b border-hair bg-canvas px-5 py-3">
      <div className="flex min-w-0 flex-1 flex-col gap-0.5 whitespace-nowrap">
        {editing && convo ? (
          <input
            autoFocus
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={() => {
              if (draft.trim()) onRename(draft.trim());
              setEditing(false);
            }}
            onKeyDown={(e) => {
              if (e.key === "Enter") e.currentTarget.blur();
              if (e.key === "Escape") setEditing(false);
            }}
            className="max-w-[520px] rounded-[7px] border border-accent-line bg-surface px-2 py-0.5 text-base font-semibold tracking-tight text-fg focus:outline-none"
          />
        ) : (
          <button
            type="button"
            disabled={!convo}
            onClick={() => {
              if (!convo) return;
              setDraft(convo.title);
              setEditing(true);
            }}
            title={convo ? "Rename conversation" : undefined}
            className="flex cursor-text items-center gap-2 text-left text-fg transition-colors hover:text-accent-text disabled:pointer-events-none"
          >
            <span className="max-w-[460px] truncate text-base font-semibold tracking-tight">
              {convo?.title ?? "New conversation"}
            </span>
            {convo && <PencilIcon className="size-3 opacity-55" />}
          </button>
        )}
        <span className="data text-[10.5px] text-fg-subtle">
          {turns} {turns === 1 ? "turn" : "turns"}
          {contextTokens != null && ` · ${contextTokens.toLocaleString()} tokens in context`}
        </span>
      </div>

      <ModelSelect
        value={model}
        onChange={onModelChange}
        models={models}
        profile={profile}
        disabled={pickerDisabled}
        variant="pill"
        ariaLabel="Chat model"
        className="shrink-0"
      />

      {contextTokens != null && (
        <div className="flex shrink-0 flex-col items-end gap-1 px-1">
          <span className="data text-[11px] text-fg-muted">
            context {contextTokens.toLocaleString()} / {formatContext(DEFAULT_CONTEXT)}
          </span>
          <Meter fraction={contextTokens / DEFAULT_CONTEXT} color="var(--accent-text)" className="w-24" />
        </div>
      )}
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
      <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-3 text-center">
        <span className="flex size-12 items-center justify-center rounded-xl border border-hair bg-accent-soft text-accent-text">
          <SendIcon className="size-5" />
        </span>
        <p className="text-sm font-medium text-fg">Chat with your local models</p>
        <span className="data inline-flex items-center gap-2 text-[11px] text-fg-subtle">
          <span className="size-[5px] rounded-full bg-ok" aria-hidden />
          This conversation never leaves your Mac
        </span>
      </div>
    );
  }

  return (
    <div className="scrollbar-slim min-h-0 flex-1 overflow-y-auto pb-2 pt-6">
      <div className="mx-auto flex max-w-[760px] flex-col gap-6 px-6">
        {messages.map((m, i) => (
          <ChatMessage
            key={m.id}
            message={m}
            streaming={running && i === messages.length - 1 && m.role === "assistant"}
          />
        ))}
        {error && (
          <p className="rounded-[9px] border border-danger/40 bg-inset px-3.5 py-3 text-sm text-danger">{error}</p>
        )}
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
    <div className="mx-auto max-w-[760px] overflow-hidden rounded-xl border border-hair bg-surface transition-colors duration-150 ease-out focus-within:border-hair2">
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
        placeholder="Ask anything…"
        aria-label="Message"
        className="scrollbar-slim max-h-52 w-full resize-none bg-transparent px-4 pb-1 pt-3.5 text-sm leading-[1.6] text-fg placeholder:text-fg-subtle focus:outline-none"
      />
      <div className="flex items-center gap-2 px-3 pb-2.5 pt-2">
        <span className="data ml-auto text-[10.5px] text-fg-subtle">↩ to send</span>
        <button
          type="button"
          onClick={onSend}
          disabled={disabled || running || !value.trim()}
          aria-label="Send message"
          className="flex size-[30px] shrink-0 cursor-pointer items-center justify-center rounded-[9px] bg-accent text-accent-fg transition-[filter,transform] duration-150 ease-out hover:brightness-110 active:scale-95 disabled:pointer-events-none disabled:opacity-40"
        >
          <SendIcon className="size-4" />
        </button>
      </div>
    </div>
  );
}
