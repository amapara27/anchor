import { useCallback, useEffect, useRef, useState } from "react";
import { Channel, invoke } from "@tauri-apps/api/core";
import type { MlxCatalogModel, MlxDownloadProgress, MlxModel } from "../types";

export function useMlxModels() {
  const [models, setModels] = useState<MlxModel[]>([]);
  const [catalog, setCatalog] = useState<MlxCatalogModel[]>([]);
  const [selected, setSelected] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [download, setDownload] = useState<MlxDownloadProgress | null>(null);
  const [cancelling, setCancelling] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const active = useRef(false);

  const refresh = useCallback(async () => {
    let paths: unknown = [];
    try { paths = JSON.parse(localStorage.getItem("anchor.mlx-models") ?? "[]"); } catch {}
    const [local, curated] = await Promise.all([
      invoke<MlxModel[]>("mlx_models", {paths: Array.isArray(paths) ? paths.filter(p => typeof p === "string").slice(0, 20) : []}),
      invoke<MlxCatalogModel[]>("mlx_catalog"),
    ]);
    setModels(local); setCatalog(curated);
  }, []);
  useEffect(() => { void refresh().catch(e => setError(String(e))).finally(() => setLoading(false)); }, [refresh]);

  const value = selected ?? models[0]?.path ?? catalog[0]?.id ?? "";
  const curated = catalog.find(m => m.id === value || m.path === value);
  const modelPath = curated ? curated.path : models.find(m => m.path === value)?.path ?? null;
  const remember = (model: MlxModel) => {
    setModels(current => {
      const next = current.filter(m => m.path !== model.path).concat(model);
      localStorage.setItem("anchor.mlx-models", JSON.stringify(next.map(m => m.path).slice(-20)));
      return next;
    });
  };
  const choose = async (id: string) => {
    setError(null); setNotice(null);
    if (id !== "__add_mlx__") { setSelected(id); return; }
    try {
      const model = await invoke<MlxModel | null>("choose_mlx_model");
      if (model) { remember(model); setSelected(model.path); }
    } catch(e) { setError(String(e)); }
  };
  const start = async () => {
    if (!curated || active.current) return;
    active.current = true; setError(null); setNotice(null); setCancelling(false);
    setDownload({status: "Preparing download…", completed: 0, total: curated.files.reduce((n, f) => n + f.bytes, 0)});
    const channel = new Channel<MlxDownloadProgress>();
    channel.onmessage = progress => setDownload(progress);
    try {
      const model = await invoke<MlxModel>("download_mlx_model", {id: curated.id, onEvent: channel});
      remember(model);
      setCatalog(current => current.map(m => m.id === curated.id ? {...m, path: model.path} : m));
      setSelected(curated.id); setNotice("Model ready. Run the suite when you’re ready.");
    } catch(e) {
      if (String(e).toLowerCase().includes("cancelled")) setNotice("Download cancelled. Retry to reuse cached files.");
      else setError("Download could not finish. Retry to reuse cached files. " + String(e));
    } finally { active.current = false; setDownload(null); setCancelling(false); }
  };
  const cancel = async () => {
    setCancelling(true);
    try { await invoke("cancel_mlx_download"); }
    catch(e) { setCancelling(false); setError(String(e)); }
  };
  return {models, catalog, value, curated, modelPath, loading, error, setError, download, cancelling, notice, choose, start, cancel};
}
