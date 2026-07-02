import { useCallback, useEffect, useMemo, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { Model } from "../types";
import { formatBytes } from "../lib/format";
import { getLastUsed } from "../lib/lastUsed";
import { PageHeader } from "./PageHeader";
import { DataTable, Td, Th, Tr } from "./ui/DataTable";
import { Button } from "./ui/Button";
import { Figure } from "./ui/Figure";
import { TrashIcon } from "./icons";

// ponytail: 30 days of no use marks a model stale. Bump if users hoard rarely-run models.
const STALE_DAYS = 30;
const STALE_MS = STALE_DAYS * 86_400_000;

/** Last-used date, e.g. "Mar 3, 2026", or "never" when untracked. */
function formatLastUsed(ms: number | null): string {
  if (ms == null) return "never";
  return new Date(ms).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

/** Disk view: installed models by size, with a one-click reclaim of stale ones. */
export function DiskPage() {
  const [models, setModels] = useState<Model[]>([]);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    invoke<Model[]>("list_models")
      .then((installed) => {
        setModels(installed);
        setError(null);
      })
      .catch((e) => setError(String(e)));
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  // Newest-first by size so the biggest offenders are on top.
  const rows = useMemo(
    () =>
      models
        .map((m) => ({ model: m, lastUsed: getLastUsed(m.id) }))
        .sort((a, b) => (b.model.size_bytes ?? 0) - (a.model.size_bytes ?? 0)),
    [models],
  );

  const now = Date.now();
  const isStale = (lastUsed: number | null) => lastUsed == null || now - lastUsed > STALE_MS;
  const reclaimBytes = rows
    .filter((r) => isStale(r.lastUsed))
    .reduce((sum, r) => sum + (r.model.size_bytes ?? 0), 0);

  const remove = useCallback(
    async (m: Model) => {
      if (!confirm(`Remove ${m.name}? This frees ${formatBytes(m.size_bytes)} and cannot be undone.`)) {
        return;
      }
      try {
        await invoke("remove_model", { id: m.id });
      } catch (e) {
        setError(String(e));
      } finally {
        load();
      }
    },
    [load],
  );

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Storage"
        title="Disk usage"
        subtitle="See what each installed model costs on disk and reclaim space from stale ones."
      />

      {error && <p className="text-sm text-danger">{error}</p>}

      <Figure
        label={`Reclaimable — unused ${STALE_DAYS}+ days`}
        value={formatBytes(reclaimBytes)}
        sub={
          reclaimBytes > 0
            ? "Remove the stale models below to free this space."
            : "No stale models — everything's been used recently."
        }
      />

      {rows.length === 0 ? (
        <p className="text-sm text-fg-muted">No models installed.</p>
      ) : (
        <DataTable>
          <thead>
            <Tr className="hover:bg-transparent">
              <Th>Model</Th>
              <Th className="text-right">Size</Th>
              <Th>Last used</Th>
              <Th aria-label="Actions" />
            </Tr>
          </thead>
          <tbody>
            {rows.map(({ model, lastUsed }) => (
              <Tr key={model.id}>
                <Td>
                  <span className="data truncate font-medium text-fg">{model.name}</span>
                </Td>
                <Td className="text-right tabular">{formatBytes(model.size_bytes)}</Td>
                <Td className={isStale(lastUsed) ? "text-fg-subtle" : "text-fg-muted"}>
                  {formatLastUsed(lastUsed)}
                </Td>
                <Td className="text-right">
                  <Button
                    variant={isStale(lastUsed) ? "primary" : "text"}
                    className="px-2 py-1 text-xs"
                    onClick={() => remove(model)}
                  >
                    <TrashIcon className="size-3.5" /> Remove
                  </Button>
                </Td>
              </Tr>
            ))}
          </tbody>
        </DataTable>
      )}
    </div>
  );
}
