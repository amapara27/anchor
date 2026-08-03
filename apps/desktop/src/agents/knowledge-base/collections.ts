/**
 * Knowledge bases: a named corpus plus the local model that answers from it.
 *
 * The list lives in localStorage because the corpus itself doesn't need it —
 * membership rides on the stored document id (`<kb id>::<path>`), which is what
 * `knowledge_base.rs` filters on. ponytail: move both to a real column the next
 * time the schema migrates.
 */
import { useCallback, useEffect, useState } from "react";
import { open } from "@tauri-apps/plugin-dialog";

const STORAGE_KEY = "anchor.knowledgeBases";
/** Must match `ID_SEP` in `agents/knowledge_base.rs`. */
const ID_SEP = "::";

export interface KnowledgeBase {
  id: string;
  name: string;
  /** The local model this base answers with. */
  model: string;
}

/** Whether a stored document belongs to a knowledge base. */
export function belongsTo(docId: string, kbId: string): boolean {
  return docId.startsWith(kbId + ID_SEP);
}

function load(): KnowledgeBase[] {
  try {
    const parsed = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "[]");
    return Array.isArray(parsed) ? (parsed as KnowledgeBase[]) : [];
  } catch {
    return []; // corrupt entry: start clean rather than break the panel
  }
}

/** The user's knowledge bases, persisted on every change. */
export function useKnowledgeBases() {
  const [bases, setBases] = useState<KnowledgeBase[]>(load);
  const [activeId, setActiveId] = useState(() => load()[0]?.id ?? "");

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(bases));
  }, [bases]);

  const create = useCallback((name: string, model: string) => {
    const base = { id: crypto.randomUUID(), name, model };
    setBases((list) => [...list, base]);
    setActiveId(base.id);
    return base;
  }, []);

  const update = useCallback((id: string, patch: Partial<KnowledgeBase>) => {
    setBases((list) => list.map((b) => (b.id === id ? { ...b, ...patch } : b)));
  }, []);

  const remove = useCallback((id: string) => {
    setBases((list) => {
      const rest = list.filter((b) => b.id !== id);
      setActiveId(rest[0]?.id ?? "");
      return rest;
    });
  }, []);

  return { bases, active: bases.find((b) => b.id === activeId) ?? null, setActiveId, create, update, remove };
}

/** Documents the backend can index. `*` is offered too — anything unreadable is
 *  rejected by the executor with a message rather than indexed as garbage. */
const FILTERS = [
  { name: "Documents", extensions: ["pdf", "txt", "md", "markdown", "rst", "csv", "json", "html", "xml", "log"] },
  { name: "Images", extensions: ["png", "jpg", "jpeg", "gif", "webp", "bmp", "tif", "tiff", "heic", "svg"] },
  { name: "All files", extensions: ["*"] },
];

/** Native picker for one file to ingest, or `null` when cancelled. */
export async function pickKbFile(): Promise<string | null> {
  const picked = await open({ multiple: false, directory: false, filters: FILTERS });
  return typeof picked === "string" ? picked : null;
}
