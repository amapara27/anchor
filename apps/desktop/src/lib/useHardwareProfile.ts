import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { HardwareProfile } from "../types";

/**
 * Owns the host hardware profile: fetches it over Tauri (the backend profiles
 * the Mac once via `system_profiler` and caches the result to disk, so this is
 * cheap on every launch after the first). `refresh` re-runs the profiler.
 *
 * Mirrors the shape of {@link useModels}: data + loading + error, fetched on
 * mount, with a graceful catch so a profiling failure never blocks the UI.
 */
export function useHardwareProfile() {
  const [profile, setProfile] = useState<HardwareProfile | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    setLoading(true);
    invoke<HardwareProfile>("get_hardware_profile")
      .then((p) => {
        setProfile(p);
        setError(null);
      })
      .catch((e) => setError(String(e)))
      .finally(() => setLoading(false));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const refresh = useCallback(() => {
    setLoading(true);
    invoke<HardwareProfile>("refresh_hardware_profile")
      .then((p) => {
        setProfile(p);
        setError(null);
      })
      .catch((e) => setError(String(e)))
      .finally(() => setLoading(false));
  }, []);

  return { profile, loading, error, refresh };
}
