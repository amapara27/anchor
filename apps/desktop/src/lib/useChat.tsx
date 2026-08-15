import { createContext, useCallback, useContext, useEffect, useRef, useState } from "react";
import { Channel, invoke } from "@tauri-apps/api/core";
import type { ChatEvent, ChatMessage, Conversation } from "../types";
import { recordUse } from "./lastUsed";

/**
 * Owns the chat workspace: the conversation list, the active conversation's
 * messages, and every in-flight streaming turn. The backend DB is the source
 * of truth (run_chat persists both turns and keeps generating even if nobody's
 * watching); this streams optimistically into whichever conversation is
 * active and reconciles from the DB on completion.
 *
 * Generation is tracked **per conversation** (`runningIds`), not as one global
 * flag — switching to conversation B while A is still generating must not
 * block sending in B, and switching back to A must correctly show it's still
 * running rather than silently forgetting about it.
 */
function useChatState() {
  const [conversations, setConversations] = useState<Conversation[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [error, setError] = useState<string | undefined>();
  // Conversation ids with a generation currently in flight (server-side —
  // backend keeps going regardless of which conversation is on screen).
  const [runningIds, setRunningIds] = useState<Set<string>>(new Set());
  const running = activeId != null && runningIds.has(activeId);
  // Conversations whose model is still loading into memory (cold start). Set
  // from the backend's `loading` event and cleared by the first token, so the
  // several-second wait on a cold model reads as loading rather than a stall.
  const [loadingIds, setLoadingIds] = useState<Set<string>>(new Set());
  const loadingModel = activeId != null && loadingIds.has(activeId);
  const markLoading = useCallback((id: string, on: boolean) => {
    setLoadingIds((s) => {
      if (s.has(id) === on) return s;
      const next = new Set(s);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });
  }, []);
  // Mirrors `runningIds` for `send`'s synchronous re-entrancy check — reading
  // the state directly there would close over whatever it was when the
  // `send` callback was created, not its current value.
  const runningIdsRef = useRef<Set<string>>(runningIds);
  const markRunning = useCallback((id: string, on: boolean) => {
    setRunningIds((s) => {
      if (s.has(id) === on) return s;
      const next = new Set(s);
      if (on) next.add(id);
      else next.delete(id);
      runningIdsRef.current = next;
      return next;
    });
  }, []);

  // Mirrors `activeId` for the channel handlers below, which close over it at
  // send-time — a ref so a handler firing after the user has switched away
  // (and switched back) always checks where the user *actually* is now.
  const activeIdRef = useRef<string | null>(null);
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

  /** Loads a conversation's persisted messages fresh from the DB — the single
   *  source of truth for "what's actually there," used both on switch and to
   *  pick up a generation that finished while the user was looking elsewhere. */
  const loadMessages = useCallback((id: string) => {
    invoke<ChatMessage[]>("conversation_messages", { id })
      .then((list) => {
        if (activeIdRef.current === id) setMessages(list);
      })
      .catch(() => {
        if (activeIdRef.current === id) setMessages([]);
      });
  }, []);

  const select = useCallback(
    (id: string) => {
      activeIdRef.current = id;
      setActiveId(id);
      setError(undefined);
      loadMessages(id);
    },
    [loadMessages],
  );

  const create = useCallback(
    async (model: string, presetId?: string | null) => {
      const convo = await invoke<Conversation>("create_conversation", {
        model,
        presetId: presetId ?? null,
      });
      setConversations((c) => [convo, ...c]);
      activeIdRef.current = convo.id;
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
        activeIdRef.current = null;
        setActiveId(null);
        setMessages([]);
      }
      invoke("delete_conversation", { id }).catch(() => {});
    },
    [activeId],
  );

  /** Ends the in-flight turn in a conversation, keeping what it generated so
   *  far. The backend persists the partial answer and emits its usual `result`,
   *  so nothing special is needed here beyond asking it to stop. */
  const stop = useCallback((convId: string) => {
    invoke("stop_chat", { conversationId: convId }).catch(() => {}); // best-effort
  }, []);

  const send = useCallback((convId: string, model: string, content: string) => {
    if (!content.trim() || runningIdsRef.current.has(convId)) return;
    markRunning(convId, true);
    activeModel.current = model;
    recordUse(model); // feeds Storage's last-used column and its stale check
    setError(undefined);

    // Optimistic: the user turn plus an empty assistant turn to stream into.
    // Only meaningful while the user is still looking at this conversation —
    // a switch away replaces `messages` wholesale via `loadMessages`.
    const now = Date.now();
    const streamId = `stream-${now}`;
    const userMsgId = `local-${now}`;
    if (activeIdRef.current === convId) {
      setMessages((m) => [
        ...m,
        { id: userMsgId, role: "user", content, thinking: null, stats_json: null, created_ms: now },
        { id: streamId, role: "assistant", content: "", thinking: null, stats_json: null, created_ms: now + 1 },
      ]);
    }

    const channel = new Channel<ChatEvent>();
    channel.onmessage = (event) => {
      const isActive = activeIdRef.current === convId;
      if (event.kind === "loading") {
        markLoading(convId, true);
      } else if (event.kind === "token") {
        markLoading(convId, false);
        if (!isActive) return;
        setMessages((m) =>
          m.map((msg) => (msg.id === streamId ? { ...msg, content: msg.content + event.text } : msg)),
        );
      } else if (event.kind === "thinking") {
        markLoading(convId, false);
        if (!isActive) return;
        setMessages((m) =>
          m.map((msg) => (msg.id === streamId ? { ...msg, thinking: (msg.thinking ?? "") + event.text } : msg)),
        );
      } else if (event.kind === "result") {
        markRunning(convId, false);
        markLoading(convId, false);
        // Re-fetch rather than patch by id: if the user navigated away and
        // back, the optimistic placeholder this run started with is long
        // gone from `messages` (replaced by `loadMessages` on the switch),
        // so the DB — which now has the persisted reply — is the only
        // reliable source once a run's terminal event arrives.
        if (isActive) loadMessages(convId);
        reloadConversations(); // title + updated_ms ordering changed
      } else if (event.kind === "failed") {
        markRunning(convId, false);
        markLoading(convId, false);
        if (isActive) {
          setError(event.message);
          loadMessages(convId); // drops the optimistic pair; nothing was persisted for it
        }
      }
    };

    invoke("run_chat", { conversationId: convId, model, content, onEvent: channel }).catch((e) => {
      markRunning(convId, false);
      markLoading(convId, false);
      if (activeIdRef.current === convId) {
        setError(String(e));
        loadMessages(convId);
      }
    });
  }, [loadMessages, markRunning, markLoading, reloadConversations]);

  /** Re-runs the turn an assistant message belongs to.
   *
   *  The backend rewinds the conversation to the prompt behind that message and
   *  hands the prompt back; re-sending it is an ordinary `send`, so a
   *  regenerated turn behaves exactly like a fresh one. Messages are reloaded
   *  from the DB first — the rewind deleted rows still on screen. */
  const regenerate = useCallback(
    async (convId: string, model: string, messageId: string) => {
      if (runningIdsRef.current.has(convId)) return;
      const prompt = await invoke<string | null>("rewind_to_prompt", {
        conversationId: convId,
        messageId,
      }).catch(() => null);
      if (!prompt) return;
      const list = await invoke<ChatMessage[]>("conversation_messages", { id: convId }).catch(() => null);
      if (list && activeIdRef.current === convId) setMessages(list);
      send(convId, model, prompt);
    },
    [send],
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
    loadingModel,
    error,
    select,
    create,
    rename,
    remove,
    send,
    stop,
    regenerate,
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
