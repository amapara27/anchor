import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import { Channel, invoke } from "@tauri-apps/api/core";
import type { ChatEvent, ChatMessage, Conversation } from "../types";
import { recordUse } from "./lastUsed";

/**
 * Owns the chat workspace: the conversation list, the active conversation's
 * messages, and a single streaming turn. The backend DB is the source of truth
 * (run_chat persists both turns); this streams optimistically and reconciles
 * order/title from the reloaded list on completion.
 *
 * Mirrors `useResearch`'s Channel + `runId` staleness idiom and its
 * unload-on-unmount so a resident model (keep_alive:300) never strands.
 */
function useChatState() {
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | undefined>();

  const runId = useRef(0);
  // The model left resident server-side, so leaving chat can evict it.
  const activeModel = useRef<string | null>(null);

  const reloadConversations = useCallback(async () => {
    const list = await invoke<Conversation[]>("list_conversations").catch(() => []);
    setConversations(list);
    return list;
  }, []);

  useEffect(() => {
    reloadConversations();
  }, [reloadConversations]);

  const unload = useCallback(() => {
    const model = activeModel.current;
    if (!model) return;
    activeModel.current = null;
    invoke("unload_model", { model }).catch(() => {}); // best-effort
  }, []);

  const select = useCallback((id: string) => {
    runId.current++; // invalidate any in-flight stream from the previous convo
    setActiveId(id);
    setError(undefined);
    invoke<ChatMessage[]>("conversation_messages", { id })
      .then(setMessages)
      .catch(() => setMessages([]));
  }, []);

  const create = useCallback(
    async (model: string, presetId?: string | null) => {
      const convo = await invoke<Conversation>("create_conversation", {
        model,
        presetId: presetId ?? null,
      });
      setConversations((c) => [convo, ...c]);
      runId.current++;
      setActiveId(convo.id);
      setMessages([]);
      setError(undefined);
      return convo;
    },
    [],
  );

  /** Points a conversation at a preset. Takes effect on its next turn. */
  const setPreset = useCallback((id: string, presetId: string | null) => {
    setConversations((c) => c.map((x) => (x.id === id ? { ...x, preset_id: presetId } : x)));
    invoke("set_conversation_preset", { id, presetId }).catch(() => {});
  }, []);

  const rename = useCallback((id: string, title: string) => {
    setConversations((c) => c.map((x) => (x.id === id ? { ...x, title } : x)));
    invoke("rename_conversation", { id, title }).catch(() => {});
  }, []);

  const remove = useCallback(
    (id: string) => {
      setConversations((c) => c.filter((x) => x.id !== id));
      if (id === activeId) {
        runId.current++;
        setActiveId(null);
        setMessages([]);
      }
      invoke("delete_conversation", { id }).catch(() => {});
    },
    [activeId],
  );

  const send = useCallback(
    (convId: string, model: string, content: string) => {
      if (running || !content.trim()) return;
      const myRun = ++runId.current;
      activeModel.current = model;
      recordUse(model); // feeds Storage's last-used column and its stale check
      setRunning(true);
      setError(undefined);

      // Optimistic: the user turn plus an empty assistant turn to stream into.
      const now = Date.now();
      const streamId = `stream-${now}`;
      setMessages((m) => [
        ...m,
        { id: `local-${now}`, role: "user", content, thinking: null, stats_json: null, created_ms: now },
        { id: streamId, role: "assistant", content: "", thinking: null, stats_json: null, created_ms: now + 1 },
      ]);

      // A failed turn persisted nothing, so the optimistic pair has to go with
      // it — otherwise the thread keeps a user turn and a blank reply that only
      // vanish on reload.
      const dropOptimistic = () =>
        setMessages((m) => m.filter((msg) => msg.id !== streamId && msg.id !== `local-${now}`));

      const channel = new Channel<ChatEvent>();
      channel.onmessage = (event) => {
        if (runId.current !== myRun) return; // stale run — ignore
        if (event.kind === "token") {
          setMessages((m) =>
            m.map((msg) => (msg.id === streamId ? { ...msg, content: msg.content + event.text } : msg)),
          );
        } else if (event.kind === "thinking") {
          setMessages((m) =>
            m.map((msg) =>
              msg.id === streamId ? { ...msg, thinking: (msg.thinking ?? "") + event.text } : msg,
            ),
          );
        } else if (event.kind === "result") {
          // Use the authoritative final text (covers a thinking model that
          // streamed no `content` tokens), and record reasoning + stats.
          setMessages((m) =>
            m.map((msg) =>
              msg.id === streamId
                ? {
                    ...msg,
                    content: event.response,
                    thinking: event.thinking || null,
                    stats_json: JSON.stringify(event.stats),
                  }
                : msg,
            ),
          );
          setRunning(false);
          reloadConversations(); // title + updated_ms ordering changed
        } else if (event.kind === "failed") {
          setError(event.message);
          setRunning(false);
          dropOptimistic();
        }
      };

      invoke("run_chat", { conversationId: convId, model, content, onEvent: channel }).catch((e) => {
        if (runId.current !== myRun) return;
        setError(String(e));
        setRunning(false);
        dropOptimistic();
      });
    },
    [running, reloadConversations],
  );

  // Closing the app must not strand a resident model.
  // ponytail: unload only on unmount, which is now app teardown rather than a
  // tab switch — a model left over from either a switch or a model change is
  // evicted by keep_alive:300, or by hand from the residency pill.
  useEffect(() => () => unload(), [unload]);

  return {
    conversations,
    activeId,
    messages,
    running,
    error,
    select,
    create,
    rename,
    remove,
    send,
    setPreset,
  };
}

type ChatValue = ReturnType<typeof useChatState>;

const ChatContext = createContext<ChatValue | null>(null);

/**
 * Single owner of the chat state, mounted once in `App`.
 *
 * It lives above the tab switch for the same reason [`ModelsProvider`] does:
 * `App` renders each page under `<main key={tab}>`, so a tab switch unmounts the
 * whole subtree. Held inside `ChatWorkspace`, `activeId` reset to `null` on every
 * return to Chat and the next message silently started a *new* conversation
 * instead of continuing the open one.
 */
export function ChatProvider({ children }: { children: React.ReactNode }) {
  const value = useChatState();
  return <ChatContext.Provider value={value}>{children}</ChatContext.Provider>;
}

/** The shared chat state from the app-level [`ChatProvider`]. */
export function useChat(): ChatValue {
  const ctx = useContext(ChatContext);
  if (!ctx) throw new Error("useChat must be used within a ChatProvider");
  return ctx;
}
