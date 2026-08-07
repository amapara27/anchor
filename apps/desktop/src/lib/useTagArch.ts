import { useCallback, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { ArchMeta } from "../types";

/**
 * On-demand architecture metadata for models that aren't installed.
 *
 * `/api/show` only answers for installed models, so a browsable tag would
 * otherwise be stuck with the parameter-count estimate — the one that under-
 * reports MHA models several-fold. The backend reads the tag's GGUF header
 * straight from the registry (about a megabyte, never the weights) and caches it
 * against the manifest digest, so this is paid once per tag ever, and only for
 * tags the user actually asks about.
 *
 * Resolved entries are held for the session too, so re-expanding a row doesn't
 * even cross the IPC boundary.
 */
export function useTagArch() {
  const [arch, setArch] = useState<Record<string, ArchMeta | null>>({});
  const [resolving, setResolving] = useState<Record<string, boolean>>({});
  // In-flight tags, so double-clicking a row's "check" fires one read.
  const inflight = useRef<Set<string>>(new Set());

  const resolve = useCallback((tag: string, digest: string) => {
    if (inflight.current.has(tag)) return;
    inflight.current.add(tag);
    setResolving((r) => ({ ...r, [tag]: true }));

    invoke<ArchMeta | null>("tag_arch", { tag, digest })
      .then((a) => setArch((m) => ({ ...m, [tag]: a })))
      // A failed read (offline, rate-limited, unparseable header) leaves the
      // labelled estimate in place — the row stays clickable to try again.
      .catch(() => {})
      .finally(() => {
        inflight.current.delete(tag);
        setResolving((r) => ({ ...r, [tag]: false }));
      });
  }, []);

  return { arch, resolving, resolve };
}
