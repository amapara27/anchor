import { useState } from "react";
import type { DownloadState, LibraryModel, QuantId } from "../types";
import { formatBytes, formatContext, formatParams } from "../lib/format";
import { estimateFit, fitContext } from "../lib/fit";
import { resolveTokPerSec } from "../lib/tokps";
import { DataTable, Td, Th, Tr } from "./ui/DataTable";
import { Button } from "./ui/Button";
import { FitBreakdown } from "./FitBreakdown";
import { CheckIcon, ChevronDownIcon, DownloadIcon, XIcon } from "./icons";

const TIER_LABEL: Record<string, string> = { ok: "OK", tight: "Tight", wont_fit: "Won't fit", unknown: "—" };
const TIER_CLASS: Record<string, string> = {
  ok: "text-ok",
  tight: "text-warn",
  wont_fit: "text-danger",
  unknown: "text-fg-subtle",
};

interface ModelTableProps {
  models: LibraryModel[];
  downloads: Record<string, DownloadState | undefined>;
  selectedId?: string | null;
  onSelect: (id: string) => void;
  onDownload: (m: LibraryModel) => void;
  onCancel: (id: string) => void;
  /** Host chip name, for throughput estimates. */
  chip?: string | null;
  totalMemoryBytes?: number | null;
  /** Contract slots (Phase 2): per-model update / last-used annotations. */
  updates?: Record<string, boolean>;
  lastUsed?: Record<string, number>;
}

/** Dense, default view of the model library — one hairline per row, tabular figures. */
export function ModelTable({
  models,
  downloads,
  selectedId,
  onSelect,
  onDownload,
  onCancel,
  chip,
  totalMemoryBytes,
  updates,
  lastUsed,
}: ModelTableProps) {
  const [expanded, setExpanded] = useState<string | null>(null);

  return (
    <DataTable>
      <thead>
        <Tr className="hover:bg-transparent">
          <Th>Model</Th>
          <Th className="text-right">Params</Th>
          <Th>Quant</Th>
          <Th className="text-right">Context</Th>
          <Th className="text-right">Size</Th>
          <Th>Fit</Th>
          <Th className="text-right">Speed</Th>
          <Th aria-label="Actions" />
        </Tr>
      </thead>
      <tbody>
        {models.map((m) => {
          const { spec } = m;
          const q = spec.quant as QuantId;
          const fit = estimateFit(spec.params_b, q, fitContext(spec.context_tokens), { memory_bytes: totalMemoryBytes });
          const tps = resolveTokPerSec(chip ?? null, m.id, spec.params_b, q);
          const download = downloads[m.id];
          const isDownloading = download != null;
          const isOpen = expanded === m.id;

          return (
            <Row key={m.id}>
              <Tr
                onClick={() => onSelect(m.id)}
                className={["cursor-pointer", m.id === selectedId ? "bg-surface-raised" : ""].join(" ")}
              >
                <Td>
                  <div className="flex items-center gap-2">
                    <span className="data truncate font-medium text-fg">{m.name}</span>
                    {updates?.[m.id] && (
                      <span
                        title="Update available"
                        className="inline-flex items-center gap-1 rounded-md bg-accent/15 px-1.5 py-0.5 text-[10px] font-medium text-accent-text ring-1 ring-inset ring-accent/20"
                      >
                        <span className="size-1.5 rounded-full bg-accent-text" aria-hidden />
                        Update
                      </span>
                    )}
                    {lastUsed?.[m.id] && (
                      <span className="text-[11px] text-fg-subtle">{timeAgo(lastUsed[m.id])}</span>
                    )}
                  </div>
                </Td>
                <Td className="text-right">{formatParams(spec.params_b)}</Td>
                <Td className="text-fg-muted">{spec.quant}</Td>
                <Td className="text-right">{formatContext(spec.context_tokens)}</Td>
                <Td className="text-right">{formatBytes(m.status === "installed" ? m.size_bytes : spec.download_bytes)}</Td>
                <Td>
                  <button
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      setExpanded(isOpen ? null : m.id);
                    }}
                    aria-expanded={isOpen}
                    className="inline-flex items-center gap-1 font-medium transition-colors duration-150 ease-out hover:text-fg"
                  >
                    <span className={TIER_CLASS[fit.tier]}>{TIER_LABEL[fit.tier]}</span>
                    <ChevronDownIcon className={["size-3.5", isOpen ? "rotate-180" : ""].join(" ")} />
                  </button>
                </Td>
                <Td className="text-right">
                  {tps ? (
                    <span>
                      {tps.value.toFixed(1)}{" "}
                      <span className="text-[11px] text-fg-subtle">{tps.source === "measured" ? "measured" : "est."}</span>
                    </span>
                  ) : (
                    <span className="text-fg-subtle">—</span>
                  )}
                </Td>
                <Td className="text-right">
                  {m.status === "installed" ? (
                    <span className="inline-flex items-center gap-1 text-xs font-medium text-ok">
                      <CheckIcon className="size-3.5" /> Ready
                    </span>
                  ) : isDownloading ? (
                    <Button
                      variant="ghost"
                      className="px-2 py-1 text-xs"
                      onClick={(e) => {
                        e.stopPropagation();
                        onCancel(m.id);
                      }}
                    >
                      <XIcon className="size-3.5" /> Cancel
                    </Button>
                  ) : (
                    <Button
                      variant="ghost"
                      className="px-2 py-1 text-xs"
                      onClick={(e) => {
                        e.stopPropagation();
                        onDownload(m);
                      }}
                    >
                      <DownloadIcon className="size-3.5" /> Download
                    </Button>
                  )}
                </Td>
              </Tr>

              {isOpen && (
                <tr>
                  <td colSpan={8} className="border-b border-[var(--hairline)] bg-canvas px-3 py-3">
                    <FitBreakdown
                      headless
                      params_b={spec.params_b}
                      quant={spec.quant}
                      contextTokens={spec.context_tokens}
                      memoryBytes={totalMemoryBytes}
                      className="max-w-md"
                    />
                  </td>
                </tr>
              )}
            </Row>
          );
        })}
      </tbody>
    </DataTable>
  );
}

/** Fragment wrapper so a row can carry an expansion row as a sibling. */
function Row({ children }: { children: React.ReactNode }) {
  return <>{children}</>;
}

/** Compact relative time, e.g. "3d ago". ponytail: coarse buckets, good enough for a hint. */
function timeAgo(ms: number): string {
  const s = (Date.now() - ms) / 1000;
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  return `${Math.floor(s / 86400)}d ago`;
}
