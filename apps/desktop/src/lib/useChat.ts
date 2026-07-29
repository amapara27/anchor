import { useCallback, useEffect, useRef, useState } from "react";
import { Channel, invoke } from "@tauri-apps/api/core";
import type { ChatEvent, ChatMessage, Conversation } from "../types";

/**
 * Owns the chat workspace: the conversation list, the active conversation's
 * messages, and a single streaming turn. The backend DB is the source of truth
 * (run_chat persists both turns); this streams optimistically and reconciles
 * order/title from the reloaded list on completion.
 *
 * Mirrors `useResearch`'s Channel + `runId` staleness idiom and its
 * unload-on-unmount so a resident model (keep_alive:300) never strands.
 */
export function useChat() {
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
    async (model: string) => {
      const convo = await invoke<Conversation>("create_conversation", { model });
      setConversations((c) => [convo, ...c]);
      runId.current++;
      setActiveId(convo.id);
      setMessages([]);
      setError(undefined);
      return convo;
    },
    [],
  );

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
      setRunning(true);
      setError(undefined);

      // Optimistic: the user turn plus an empty assistant turn to stream into.
      const now = Date.now();
      const streamId = `stream-${now}`;
      setMessages((m) => [
        ...m,
        { id: `local-${now}`, role: "user", content, stats_json: null, created_ms: now },
        { id: streamId, role: "assistant", content: "", stats_json: null, created_ms: now + 1 },
      ]);

      const channel = new Channel<ChatEvent>();
      channel.onmessage = (event) => {
        if (runId.current !== myRun) return; // stale run — ignore
        if (event.kind === "token") {
          setMessages((m) =>
            m.map((msg) => (msg.id === streamId ? { ...msg, content: msg.content + event.text } : msg)),
          );
        } else if (event.kind === "result") {
          // Use the authoritative final text (covers a thinking model that
          // streamed no `content` tokens), and record the stats.
          setMessages((m) =>
            m.map((msg) =>
              msg.id === streamId
                ? { ...msg, content: event.response, stats_json: JSON.stringify(event.stats) }
                : msg,
            ),
          );
          setRunning(false);
          reloadConversations(); // title + updated_ms ordering changed
        } else if (event.kind === "failed") {
          setError(event.message);
          setRunning(false);
        }
      };

      invoke("run_chat", { conversationId: convId, model, content, onEvent: channel }).catch((e) => {
        if (runId.current !== myRun) return;
        setError(String(e));
        setRunning(false);
      });
    },
    [running, reloadConversations],
  );

  // Leaving chat mid-run must not strand a resident model.
  // ponytail: unload only on unmount; a mid-session model switch relies on
  // keep_alive:300 to evict the old one. Add an explicit switch-unload if it bites.
  useEffect(() => () => unload(), [unload]);

  return { conversations, activeId, messages, running, error, select, create, rename, remove, send };
}
