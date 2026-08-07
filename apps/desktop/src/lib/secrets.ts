import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";

/**
 * A secret held in the macOS Keychain, read once on mount and written back as it
 * changes.
 *
 * API keys used to sit in `localStorage`, which is an unencrypted SQLite file
 * readable by any process running as the user and left behind when the app
 * bundle is deleted. A key already stored there is migrated on first read and
 * the plaintext copy removed.
 *
 * Returns `[value, setValue, loaded]`. `loaded` is false until the Keychain read
 * settles, so a field can tell "no key stored" from "not read yet" instead of
 * flashing empty.
 */
export function useSecret(key: string): [string, (next: string) => void, boolean] {
  const [value, setValue] = useState("");
  const [loaded, setLoaded] = useState(false);
  // Skips the write-back for the value we just read out of the Keychain.
  const dirty = useRef(false);

  useEffect(() => {
    let live = true;
    (async () => {
      const stored = await invoke<string | null>("get_secret", { key }).catch(() => null);
      if (!live) return;
      const legacy = localStorage.getItem(key);
      if (!stored && legacy) {
        await invoke("set_secret", { key, value: legacy }).catch(() => {});
        localStorage.removeItem(key);
      }
      if (!live) return;
      setValue(stored ?? legacy ?? "");
      setLoaded(true);
    })();
    return () => {
      live = false;
    };
  }, [key]);

  // Debounced: a Keychain write per keystroke while pasting a key is pointless.
  useEffect(() => {
    if (!loaded || !dirty.current) return;
    const id = window.setTimeout(() => {
      invoke("set_secret", { key, value }).catch(() => {});
    }, 400);
    return () => window.clearTimeout(id);
  }, [key, value, loaded]);

  return [
    value,
    (next: string) => {
      dirty.current = true;
      setValue(next);
    },
    loaded,
  ];
}
