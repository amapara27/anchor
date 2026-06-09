import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { Model } from "./types";

export default function App() {
  const [models, setModels] = useState<Model[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    invoke<Model[]>("list_models")
      .then(setModels)
      .catch((e) => setError(String(e)))
      .finally(() => setLoading(false));
  }, []);

  return (
    <main className="min-h-screen bg-neutral-950 text-neutral-100">
      <div className="mx-auto max-w-3xl px-6 py-16">
        <header className="mb-12">
          <h1 className="text-3xl font-semibold tracking-tight">Anchor</h1>
          <p className="mt-2 text-neutral-400">
            Manage and configure local models with ease.
          </p>
        </header>

        <section>
          <h2 className="mb-4 text-sm font-medium uppercase tracking-wide text-neutral-500">
            Models
          </h2>

          {loading && <p className="text-neutral-400">Loading…</p>}

          {error && (
            <p className="rounded-md border border-red-900 bg-red-950/40 px-4 py-3 text-sm text-red-300">
              {error}
            </p>
          )}

          {!loading && !error && models.length === 0 && (
            <div className="rounded-lg border border-dashed border-neutral-800 px-6 py-12 text-center">
              <p className="text-neutral-300">No models yet.</p>
              <p className="mt-1 text-sm text-neutral-500">
                Model discovery isn&apos;t wired up yet — this is the initial
                scaffold.
              </p>
            </div>
          )}

          {!loading && !error && models.length > 0 && (
            <ul className="space-y-2">
              {models.map((model) => (
                <li
                  key={model.id}
                  className="flex items-center justify-between rounded-lg border border-neutral-800 bg-neutral-900 px-4 py-3"
                >
                  <div>
                    <p className="font-medium">{model.name}</p>
                    <p className="text-sm text-neutral-500">{model.family}</p>
                  </div>
                  <span className="rounded-full bg-neutral-800 px-2.5 py-0.5 text-xs text-neutral-300">
                    {model.status}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </section>
      </div>
    </main>
  );
}
