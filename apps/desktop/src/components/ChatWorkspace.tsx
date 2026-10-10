import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { DEFAULT_PRESET_ID, type Conversation, type GenerationStats, type Preset } from "../types";
import { useChat } from "../lib/useChat";
import { useModels } from "../lib/useModels";
import { usePresets } from "../lib/usePresets";
import { useHardwareProfile } from "../lib/useHardwareProfile";
import { useResidency } from "../lib/useResidency";
import { formatContext } from "../lib/format";
import { DEFAULT_CONTEXT } from "../lib/fit";
import { hardwareHint } from "../lib/hint";
import { ModelSelect } from "./ui/ModelSelect";
import { Select } from "./ui/Select";
import { Meter } from "./ui/SegmentedBar";
import { ChatMessage } from "./ChatMessage";
import { ConfirmDialog } from "./ui/ConfirmDialog";
import { PlusIcon, SendIcon, StopIcon } from "./icons";

/** A solid, widely-installed default (matches the Research Assistant's pick). */
const DEFAULT_MODEL = "llama3.1:8b";

/**
 * Whether loading `modelId` right now would push this Mac into heavy swap,
 * given what Ollama already has resident from other models — not just total
 * system RAM, since another model already loaded reduces real headroom.
 * `false` (never warn) when the model is already resident: no fresh load is
 * about to happen, or hardware is unknown.
 */
function wontFitGivenResidency(
  modelId: string,
  lib: ReturnType<typeof useModels>["models"],
  profile: ReturnType<typeof useHardwareProfile>["profile"],
  resident: ReturnType<typeof useResidency>["models"],
  residentBytes: number,
  context: number,
): boolean {
  if (!profile?.memory_bytes) return false;
  if (resident.some((m) => m.name === modelId)) return false;
  const m = lib.find((x) => x.id === modelId);
  if (!m) return false;
  const hint = hardwareHint(
    {
      id: m.id,
      params_b: m.spec.params_b,
      quant: m.spec.quant,
      contextTokens: m.spec.context_tokens || DEFAULT_CONTEXT,
      arch: m.arch,
      sizeBytes: m.size_bytes,
    },
    { memory_bytes: profile.memory_bytes - residentBytes, chip: profile.chip },
    context,
  );
  return hint.tier === "wont_fit";
}

/**
 * Try: one streaming thread over a local Ollama model, and a composer. Each
 * trial persists in SQLite (via `useChat`, readable with `anchor chat ls`); the
 * model pill surfaces the hardware fit hint — the moat — for the chosen model.
 */
export function ChatWorkspace() {
  const { models, loading } = useModels();
  const { profile } = useHardwareProfile();
  const { presets } = usePresets();
  const { models: resident, residentBytes } = useResidency();
  const {
    conversations,
    activeId,
    messages,
    running,
    loadingModel,
    error,
    create,
    send,
    stop,
    regenerate,
    setPreset,
  } = useChat();

  const [model, setModel] = useState("");
  const [presetId, setPresetId] = useState(DEFAULT_PRESET_ID);
  const [input, setInput] = useState("");
  const [pendingSwap, setPendingSwap] = useState<{ text: string } | null>(null);
  // Conversations (or "__new__" for one not yet created) the user has already
  // clicked through a won't-fit warning for — don't re-ask every message.
  const warnedConvos = useRef<Set<string>>(new Set());

  // Default the model once the library loads. `models` is the catalog joined
  // with install state, so it carries entries that aren't installed — picking
  // the suggested one unconditionally preselected a model Ollama doesn't have
  // and the first message failed. Only an installed model may be the default.
  useEffect(() => {
    if (model || models.length === 0) return;
    const installed = models.filter((m) => m.status === "installed");
    setModel(installed.find((m) => m.id === DEFAULT_MODEL)?.id ?? installed[0]?.id ?? "");
  }, [models, model]);

  // Follow the active conversation's model and preset when switching threads.
  const activeConvo = conversations.find((c) => c.id === activeId);
  useEffect(() => {
    if (!activeConvo) return;
    setModel(activeConvo.model);
    setPresetId(activeConvo.preset_id ?? DEFAULT_PRESET_ID);
  }, [activeConvo?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  // A preset switch applies to the open conversation; with none open it's the
  // one the next `create` starts under.
  const changePreset = (next: string) => {
    setPresetId(next);
    if (activeId) setPreset(activeId, next === DEFAULT_PRESET_ID ? null : next);
  };

  const doSend = async (text: string) => {
    setInput("");
    let id = activeId;
    if (!id) id = (await create(model, presetId)).id;
    send(id, model, text);
  };

  const handleSend = async () => {
    const text = input.trim();
    if (!text || running || !model) return;
    const key = activeId ?? "__new__";
    if (!warnedConvos.current.has(key) && wontFitGivenResidency(model, models, profile, resident, residentBytes, presets.find(p => p.id === presetId)?.num_ctx ?? DEFAULT_CONTEXT)) {
      setPendingSwap({ text });
      return;
    }
    await doSend(text);
  };

  return (
    <div className="relative flex min-w-0 flex-1">
      {/* Thread */}
      <section className="flex min-h-0 min-w-0 flex-1 flex-col">
        <ThreadHeader
          convo={activeConvo}
          messages={messages}
          model={model}
          onModelChange={setModel}
          models={models}
          presets={presets}
          presetId={presetId}
          onPresetChange={changePreset}
          profile={profile}
          pickerDisabled={running || loading}
          onNewTrial={() => void create(model, presetId)}
        />

        <MessageList
          model={model}
          messages={messages}
          running={running}
          loadingModel={loadingModel}
          error={error}
          onRegenerate={
            activeId && model && !running ? (messageId) => void regenerate(activeId, model, messageId) : undefined
          }
        />

        <div className="shrink-0 border-t border-hair bg-canvas px-6 pb-[18px] pt-3.5">
          <Composer
            value={input}
            onChange={setInput}
            onSend={handleSend}
            onStop={() => activeId && stop(activeId)}
            disabled={!model}
            running={running}
            loadingModel={loadingModel}
          />
          <p className="data mx-auto mt-2.5 max-w-[760px] text-[11px] text-fg-subtle">
            Prompts are sent to your configured Ollama server
          </p>
        </div>
      </section>

      <ConfirmDialog
        open={pendingSwap != null}
        title="This model probably won't fit"
        body="Loading it now would likely push this Mac into heavy swap — expect slow, stuttering responses. Continue anyway?"
        confirmLabel="Continue"
        onConfirm={() => {
          warnedConvos.current.add(activeId ?? "__new__");
          if (pendingSwap) void doSend(pendingSwap.text);
          setPendingSwap(null);
        }}
        onCancel={() => setPendingSwap(null)}
      />
    </div>
  );
}

/** Title, model + preset pills, the live context meter, and New trial. */
function ThreadHeader({
  convo,
  messages,
  model,
  onModelChange,
  models,
  presets,
  presetId,
  onPresetChange,
  profile,
  pickerDisabled,
  onNewTrial,
}: {
  convo: Conversation | undefined;
  messages: ReturnType<typeof useChat>["messages"];
  model: string;
  onModelChange: (id: string) => void;
  models: ReturnType<typeof useModels>["models"];
  presets: Preset[];
  presetId: string;
  onPresetChange: (id: string) => void;
  profile: ReturnType<typeof useHardwareProfile>["profile"];
  pickerDisabled: boolean;
  onNewTrial: () => void;
}) {

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

  // Measure context against what the preset actually pins, so the meter reflects
  // the window the model was loaded with rather than a nominal default.
  const contextLimit = presets.find((p) => p.id === presetId)?.num_ctx ?? DEFAULT_CONTEXT;

  return (
    <div className="chat-toolbar shrink-0">
      <div className="flex min-w-[160px] flex-1 flex-col gap-0.5">
        <span className="max-w-[460px] truncate text-base font-semibold tracking-tight text-fg">
          {convo?.title ?? "New trial"}
        </span>
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

      <Select
        value={presetId}
        onChange={onPresetChange}
        options={presets.map((p) => ({ value: p.id, label: p.name }))}
        disabled={pickerDisabled}
        variant="pill"
        ariaLabel="Inference preset"
        className="w-[128px] shrink-0"
        menuWidth={200}
      />

      {contextTokens != null && (
        <div className="flex shrink-0 flex-col items-end gap-1 px-1">
          <span className="data text-[11px] text-fg-muted">
            context {contextTokens.toLocaleString()} / {formatContext(contextLimit)}
          </span>
          <Meter fraction={contextTokens / contextLimit} color="var(--accent-text)" className="w-24" />
        </div>
      )}
      <button type="button" onClick={onNewTrial} disabled={!model || pickerDisabled} className="flex h-8 shrink-0 items-center gap-2 rounded-lg border border-hair px-3 text-[13px] text-fg transition-colors hover:border-hair2 hover:bg-inset focus:outline-none focus-visible:ring-2 focus-visible:ring-accent-line disabled:pointer-events-none disabled:opacity-40"><PlusIcon className="size-3.5 text-fg-muted" />New trial</button>
    </div>
  );
}

/** Scrolling message list that pins to the bottom as new tokens arrive. */
function MessageList({
  model,
  messages,
  running,
  loadingModel,
  error,
  onRegenerate,
}: {
  model: string;
  messages: ReturnType<typeof useChat>["messages"];
  running: boolean;
  loadingModel: boolean;
  error?: string;
  onRegenerate?: (messageId: string) => void;
}) {
  const endRef = useRef<HTMLDivElement>(null);
  // Layout effect so the jump happens before paint (no visible flash).
  useLayoutEffect(() => {
    endRef.current?.scrollIntoView({ block: "end" });
  }, [messages]);

  if (messages.length === 0) {
    return (
      <div className="flex min-h-0 flex-1 flex-col items-center justify-center gap-1.5 px-6 text-center">
        <p className="text-[15px] font-medium tracking-tight text-fg">Try your local model</p>
        {model && <p className="data text-[12px] text-fg-muted">{model}</p>}
      </div>
    );
  }

  return (
    <div className="scrollbar-slim min-h-0 flex-1 overflow-y-auto pb-2 pt-6">
      <div className="mx-auto flex max-w-[760px] flex-col gap-6 px-6">
        {messages.map((m, i) => {
          const last = i === messages.length - 1 && m.role === "assistant";
          return (
            <ChatMessage
              key={m.id}
              message={m}
              streaming={running && last}
              loadingModel={loadingModel}
              // Only the newest answer: rewinding an earlier one would discard
              // every turn after it, which no button should do by surprise.
              onRegenerate={last && onRegenerate ? () => onRegenerate(m.id) : undefined}
            />
          );
        })}
        {error && (
          <p className="rounded-[9px] border border-danger/40 bg-inset px-3.5 py-3 text-sm text-danger">{error}</p>
        )}
        <div ref={endRef} />
      </div>
    </div>
  );
}

/** Auto-growing composer: Enter sends, Shift+Enter inserts a newline. While a
 *  turn is generating the send button becomes Stop — the partial answer is kept,
 *  so stopping shortens a turn rather than discarding it. */
function Composer({
  value,
  onChange,
  onSend,
  onStop,
  disabled,
  running,
  loadingModel,
}: {
  value: string;
  onChange: (v: string) => void;
  onSend: () => void;
  onStop: () => void;
  disabled: boolean;
  running: boolean;
  loadingModel: boolean;
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
    <div className="mx-auto max-w-[760px] overflow-hidden rounded-card border border-hair bg-surface transition-colors duration-150 ease-out focus-within:border-hair2 focus-within:ring-2 focus-within:ring-accent-line">
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
        <span className="data ml-auto text-[10.5px] text-fg-subtle">
          {running ? (loadingModel ? "loading model…" : "generating…") : <><kbd className="rounded border border-hair px-1 py-px">↩</kbd> send</>}
        </span>
        {running ? (
          <button
            type="button"
            onClick={onStop}
            aria-label="Stop generating"
            title="Stop generating — keeps what's been written"
            className="flex size-[30px] shrink-0 cursor-pointer items-center justify-center rounded-control border border-hair2 bg-inset text-fg transition-colors duration-150 ease-out hover:border-danger hover:text-danger"
          >
            <StopIcon className="size-3" />
          </button>
        ) : (
          <button
            type="button"
            onClick={onSend}
            disabled={disabled || !value.trim()}
            aria-label="Send message"
            className="flex size-[30px] shrink-0 cursor-pointer items-center justify-center rounded-control bg-fg text-canvas transition-[opacity,transform] duration-150 ease-out hover:opacity-90 active:scale-95 disabled:pointer-events-none disabled:opacity-40"
          >
            <SendIcon className="size-4" />
          </button>
        )}
      </div>
    </div>
  );
}
