import { useEffect, useRef, useState } from "react";
import type { DownloadState, LibraryModel } from "../types";
import { formatBytes, formatContext, formatParams } from "../lib/format";
import { StatusBadge } from "./StatusBadge";
import {
  ChipIcon,
  CloseIcon,
  DownloadIcon,
  HardDriveIcon,
  LayersIcon,
  MemoryIcon,
  RulerIcon,
  TagIcon,
  TrashIcon,
  XIcon,
} from "./icons";

interface DrawerProps {
  model: LibraryModel | null;
  download?: DownloadState;
  onClose: () => void;
  onDownload: () => void;
  onCancel: () => void;
  onRemove: () => void;
  onTagsChange: (tags: string[]) => void;
  onNoteChange: (note: string) => void;
}

export function ModelDetailDrawer({
  model,
  download,
  onClose,
  onDownload,
  onCancel,
  onRemove,
  onTagsChange,
  onNoteChange,
}: DrawerProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const open = model != null;

  // Escape to close + focus the panel when it opens (a11y: escape-routes).
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    panelRef.current?.focus();
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  return (
    <div
      className={[
        "fixed inset-0 z-40 transition-opacity duration-200",
        open ? "pointer-events-auto opacity-100" : "pointer-events-none opacity-0",
      ].join(" ")}
      aria-hidden={!open}
    >
      {/* Scrim — strong enough to isolate the panel (a11y: modal legibility). */}
      <div
        className="absolute inset-0 bg-slate-950/70 backdrop-blur-sm"
        onClick={onClose}
        aria-hidden
      />

      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={model ? `${model.name} details` : undefined}
        tabIndex={-1}
        className={[
          "scrollbar-slim absolute right-0 top-0 flex h-full w-full max-w-md flex-col overflow-y-auto",
          "border-l border-slate-800 bg-slate-900 shadow-2xl outline-none transition-transform duration-300 ease-out",
          open ? "translate-x-0" : "translate-x-full",
        ].join(" ")}
      >
        {model && (
          <DrawerBody
            model={model}
            download={download}
            onClose={onClose}
            onDownload={onDownload}
            onCancel={onCancel}
            onRemove={onRemove}
            onTagsChange={onTagsChange}
            onNoteChange={onNoteChange}
          />
        )}
      </div>
    </div>
  );
}

function DrawerBody({
  model,
  download,
  onClose,
  onDownload,
  onCancel,
  onRemove,
  onTagsChange,
  onNoteChange,
}: DrawerProps & { model: LibraryModel }) {
  const { spec } = model;
  const installed = model.status === "installed";
  const isDownloading = download != null;

  return (
    <>
      {/* Header */}
      <div className="sticky top-0 z-10 flex items-start justify-between gap-3 border-b border-slate-800 bg-slate-900/95 px-5 py-4 backdrop-blur">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <h2 className="truncate text-lg font-semibold text-slate-100">{model.name}</h2>
            <StatusBadge status={model.status} />
          </div>
          <p className="mt-0.5 font-mono text-xs text-slate-500">{model.id}</p>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close details"
          className="-mr-1 shrink-0 cursor-pointer rounded-lg p-1.5 text-slate-400 transition-colors hover:bg-slate-800 hover:text-slate-100 focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-500/40"
        >
          <CloseIcon className="size-5" />
        </button>
      </div>

      <div className="flex-1 space-y-6 px-5 py-5">
        <p className="text-sm leading-relaxed text-slate-300">{spec.blurb}</p>

        {/* Specs */}
        <section>
          <SectionLabel>Specifications</SectionLabel>
          <dl className="grid grid-cols-2 gap-2">
            <SpecRow icon={<RulerIcon className="size-4" />} label="Parameters" value={formatParams(spec.params_b)} />
            <SpecRow icon={<LayersIcon className="size-4" />} label="Quantization" value={spec.quant} />
            <SpecRow icon={<ChipIcon className="size-4" />} label="Context" value={`${formatContext(spec.context_tokens)} tokens`} />
            <SpecRow
              icon={<HardDriveIcon className="size-4" />}
              label={installed ? "On disk" : "Download size"}
              value={formatBytes(installed ? model.size_bytes : spec.download_bytes)}
            />
          </dl>
        </section>

        {/* Hardware */}
        <section>
          <SectionLabel>Hardware</SectionLabel>
          <div className="flex items-center gap-3 rounded-lg border border-slate-800 bg-slate-800/30 px-3 py-2.5">
            <MemoryIcon className="size-4 shrink-0 text-slate-500" />
            <div className="min-w-0 flex-1">
              <p className="text-sm text-slate-200">{formatBytes(spec.min_memory_bytes)} memory recommended</p>
              <p className="text-xs text-slate-500">Unified memory on Apple Silicon, or RAM + VRAM elsewhere.</p>
            </div>
          </div>
        </section>

        {/* Use cases */}
        {spec.use_cases.length > 0 && (
          <section>
            <SectionLabel>Good for</SectionLabel>
            <div className="flex flex-wrap gap-1.5">
              {spec.use_cases.map((uc) => (
                <span
                  key={uc}
                  className="rounded-md bg-slate-800/60 px-2.5 py-1 text-xs text-slate-300 ring-1 ring-inset ring-slate-700/60"
                >
                  {uc}
                </span>
              ))}
            </div>
          </section>
        )}

        {/* Tags */}
        <section>
          <SectionLabel>Tags</SectionLabel>
          <TagEditor tags={model.tags} onChange={onTagsChange} />
        </section>

        {/* Notes */}
        <section>
          <SectionLabel>Notes</SectionLabel>
          <textarea
            value={model.note}
            onChange={(e) => onNoteChange(e.target.value)}
            rows={4}
            placeholder="Add your own notes about this model…"
            className="scrollbar-slim w-full resize-none rounded-lg border border-slate-800 bg-slate-950/40 px-3 py-2 text-sm text-slate-200 placeholder:text-slate-600 focus:border-emerald-500/50 focus:outline-none focus:ring-2 focus:ring-emerald-500/20"
          />
        </section>
      </div>

      {/* Sticky action bar */}
      <div className="sticky bottom-0 border-t border-slate-800 bg-slate-900/95 px-5 py-4 backdrop-blur">
        {isDownloading ? (
          <DrawerProgress download={download} totalBytes={spec.download_bytes} onCancel={onCancel} />
        ) : installed ? (
          <button
            type="button"
            onClick={onRemove}
            className="inline-flex w-full cursor-pointer items-center justify-center gap-2 rounded-lg border border-red-500/30 bg-red-500/10 px-4 py-2.5 text-sm font-medium text-red-300 transition-colors hover:bg-red-500/20 focus:outline-none focus-visible:ring-2 focus-visible:ring-red-500/40"
          >
            <TrashIcon className="size-4" /> Remove from disk
          </button>
        ) : (
          <button
            type="button"
            onClick={onDownload}
            className="inline-flex w-full cursor-pointer items-center justify-center gap-2 rounded-lg bg-emerald-500 px-4 py-2.5 text-sm font-semibold text-slate-950 transition-colors hover:bg-emerald-400 focus:outline-none focus-visible:ring-2 focus-visible:ring-emerald-400/60"
          >
            <DownloadIcon className="size-4" /> Download · {formatBytes(spec.download_bytes)}
          </button>
        )}
      </div>
    </>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">{children}</h3>
  );
}

function SpecRow({ icon, label, value }: { icon: React.ReactNode; label: string; value: string }) {
  return (
    <div className="rounded-lg border border-slate-800 bg-slate-800/30 px-3 py-2">
      <div className="flex items-center gap-1.5 text-slate-500">
        {icon}
        <span className="text-xs">{label}</span>
      </div>
      <p className="tabular mt-1 text-sm font-medium text-slate-100">{value}</p>
    </div>
  );
}

function TagEditor({ tags, onChange }: { tags: string[]; onChange: (tags: string[]) => void }) {
  const [draft, setDraft] = useState("");

  const add = () => {
    const t = draft.trim();
    if (t && !tags.includes(t)) onChange([...tags, t]);
    setDraft("");
  };

  return (
    <div>
      {tags.length > 0 && (
        <div className="mb-2 flex flex-wrap gap-1.5">
          {tags.map((tag) => (
            <span
              key={tag}
              className="inline-flex items-center gap-1 rounded-md bg-emerald-500/10 py-0.5 pl-2 pr-1 text-xs font-medium text-emerald-300 ring-1 ring-inset ring-emerald-500/20"
            >
              {tag}
              <button
                type="button"
                onClick={() => onChange(tags.filter((x) => x !== tag))}
                aria-label={`Remove tag ${tag}`}
                className="cursor-pointer rounded p-0.5 text-emerald-400/70 transition-colors hover:bg-emerald-500/20 hover:text-emerald-200 focus:outline-none focus-visible:ring-1 focus-visible:ring-emerald-400"
              >
                <XIcon className="size-3" />
              </button>
            </span>
          ))}
        </div>
      )}
      <div className="relative">
        <TagIcon className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-slate-500" />
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              add();
            }
          }}
          onBlur={add}
          placeholder="Add a tag and press Enter"
          aria-label="Add a tag"
          className="w-full rounded-lg border border-slate-800 bg-slate-950/40 py-1.5 pl-8 pr-3 text-sm text-slate-200 placeholder:text-slate-600 focus:border-emerald-500/50 focus:outline-none focus:ring-2 focus:ring-emerald-500/20"
        />
      </div>
    </div>
  );
}

function DrawerProgress({
  download,
  totalBytes,
  onCancel,
}: {
  download: DownloadState;
  totalBytes: number;
  onCancel: () => void;
}) {
  const pct = Math.round(download.progress * 100);
  const verifying = download.status === "verifying";
  return (
    <div>
      <div className="mb-1.5 flex items-center justify-between text-sm">
        <span className="font-medium text-slate-200">{verifying ? "Verifying…" : `Downloading… ${pct}%`}</span>
        <button
          type="button"
          onClick={onCancel}
          className="cursor-pointer text-xs font-medium text-slate-400 transition-colors hover:text-slate-200 focus:outline-none focus-visible:underline"
        >
          Cancel
        </button>
      </div>
      <div
        className="h-2 overflow-hidden rounded-full bg-slate-800"
        role="progressbar"
        aria-valuenow={pct}
        aria-valuemin={0}
        aria-valuemax={100}
      >
        <div
          className="h-full rounded-full bg-emerald-500 transition-[width] duration-150 ease-out"
          style={{ width: `${verifying ? 100 : pct}%` }}
        />
      </div>
      <p className="tabular mt-1.5 text-xs text-slate-500">
        {formatBytes(download.receivedBytes)} / {formatBytes(totalBytes)}
      </p>
    </div>
  );
}
