import { useEffect, useRef, useState } from "react";
import type { DownloadState, LibraryModel } from "../types";
import { formatBytes, formatContext, formatParams } from "../lib/format";
import { StatusBadge } from "./StatusBadge";
import { FitBreakdown } from "./FitBreakdown";
import { Chip } from "./ui/Chip";
import { Button } from "./ui/Button";
import { ConfirmDialog } from "./ui/ConfirmDialog";
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
import { ProgressTrack } from "./DownloadProgressBar";

interface DrawerProps {
  model: LibraryModel | null;
  download?: DownloadState;
  onClose: () => void;
  onDownload: () => void;
  onCancel: () => void;
  onRemove: () => void;
  onTagsChange: (tags: string[]) => void;
  onNoteChange: (note: string) => void;
  /** Host total memory in bytes, for the hardware-compatibility line. */
  totalMemoryBytes?: number | null;
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
  totalMemoryBytes,
}: DrawerProps) {
  const panelRef = useRef<HTMLDivElement>(null);
  const open = model != null;
  const [confirmRemove, setConfirmRemove] = useState(false);

  // Escape to close + focus the panel when it opens (a11y: escape-routes).
  // While the remove confirm is up, Escape belongs to the dialog, not the drawer.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !confirmRemove) onClose();
    };
    document.addEventListener("keydown", onKey);
    panelRef.current?.focus();
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onClose, confirmRemove]);

  // A different model (or a closed drawer) discards any pending confirm.
  useEffect(() => setConfirmRemove(false), [model?.id]);

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
        className="absolute inset-0 bg-black/60"
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
          "border-l border-white/10 bg-surface shadow-overlay outline-none transition-transform duration-300 [transition-timing-function:var(--ease-out)]",
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
            onRemove={() => setConfirmRemove(true)}
            onTagsChange={onTagsChange}
            onNoteChange={onNoteChange}
            totalMemoryBytes={totalMemoryBytes}
          />
        )}
      </div>

      {model && (
        <ConfirmDialog
          open={confirmRemove}
          title="Remove from disk?"
          body={`${model.name} will be deleted from Ollama, freeing ${formatBytes(model.size_bytes)}. This cannot be undone.`}
          confirmLabel="Remove"
          onConfirm={() => {
            setConfirmRemove(false);
            onRemove();
          }}
          onCancel={() => setConfirmRemove(false)}
        />
      )}
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
  totalMemoryBytes,
}: DrawerProps & { model: LibraryModel }) {
  const { spec } = model;
  const installed = model.status === "installed";
  const isDownloading = download != null;

  return (
    <>
      {/* Header */}
      <div className="sticky top-0 z-10 flex items-start justify-between gap-3 border-b border-white/8 bg-surface px-5 py-4">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <h2 className="data truncate text-lg font-semibold text-fg">{model.name}</h2>
            <StatusBadge status={model.status} />
          </div>
          <p className="data mt-0.5 text-xs text-fg-subtle">{model.id}</p>
        </div>
        <button
          type="button"
          onClick={onClose}
          aria-label="Close details"
          className="-mr-1 shrink-0 cursor-pointer rounded-lg p-1.5 text-fg-muted transition-colors hover:bg-white/6 hover:text-fg focus:outline-none focus-visible:ring-2 focus-visible:ring-accent/45"
        >
          <CloseIcon className="size-5" />
        </button>
      </div>

      <div className="flex-1 space-y-6 px-5 py-5">
        <p className="text-sm leading-relaxed text-fg-muted">{spec.blurb}</p>

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
          <div className="flex items-center gap-3 rounded-lg border border-white/8 bg-white/5 px-3 py-2.5">
            <MemoryIcon className="size-4 shrink-0 text-fg-subtle" />
            <div className="min-w-0 flex-1">
              <p className="text-sm text-fg">{formatBytes(spec.min_memory_bytes)} memory recommended</p>
              <p className="text-xs text-fg-subtle">Unified memory on Apple Silicon, or RAM + VRAM elsewhere.</p>
            </div>
          </div>
          {spec.params_b > 0 && (
            <FitBreakdown
              className="mt-3"
              defaultOpen
              params_b={spec.params_b}
              quant={spec.quant}
              contextTokens={spec.context_tokens}
              memoryBytes={totalMemoryBytes}
              arch={model.arch}
              sizeBytes={model.size_bytes}
            />
          )}
        </section>

        {/* Use cases */}
        {spec.use_cases.length > 0 && (
          <section>
            <SectionLabel>Good for</SectionLabel>
            <div className="flex flex-wrap gap-1.5">
              {spec.use_cases.map((uc) => (
                <Chip key={uc}>{uc}</Chip>
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
            className="scrollbar-slim w-full resize-none rounded-lg border border-white/8 bg-white/5 px-3 py-2 text-sm text-fg placeholder:text-fg-subtle focus:border-accent/60 focus:outline-none focus:ring-2 focus:ring-accent/25"
          />
        </section>
      </div>

      {/* Sticky action bar */}
      <div className="sticky bottom-0 border-t border-white/8 bg-surface px-5 py-4">
        {isDownloading ? (
          <DrawerProgress download={download} totalBytes={spec.download_bytes} onCancel={onCancel} />
        ) : installed ? (
          <button
            type="button"
            onClick={onRemove}
            className="inline-flex w-full cursor-pointer items-center justify-center gap-2 rounded-lg border border-danger/30 bg-danger/10 px-4 py-2.5 text-sm font-medium text-danger transition-colors hover:bg-danger/15 focus:outline-none focus-visible:ring-2 focus-visible:ring-danger/40"
          >
            <TrashIcon className="size-4" /> Remove from disk
          </button>
        ) : (
          <Button variant="primary" onClick={onDownload} className="w-full py-2.5">
            <DownloadIcon className="size-4" /> Download · {formatBytes(spec.download_bytes)}
          </Button>
        )}
      </div>
    </>
  );
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <h3 className="label-caps mb-2">{children}</h3>
  );
}

function SpecRow({ icon, label, value }: { icon: React.ReactNode; label: string; value: string }) {
  return (
    <div className="rounded-lg border border-white/8 bg-white/5 px-3 py-2">
      <div className="flex items-center gap-1.5 text-fg-subtle">
        {icon}
        <span className="text-xs">{label}</span>
      </div>
      <p className="data mt-1 text-sm font-medium text-fg">{value}</p>
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
            <Chip key={tag} className="gap-1 pr-1">
              {tag}
              <button
                type="button"
                onClick={() => onChange(tags.filter((x) => x !== tag))}
                aria-label={`Remove tag ${tag}`}
                className="cursor-pointer rounded p-0.5 text-fg-subtle transition-colors hover:bg-white/10 hover:text-fg focus:outline-none focus-visible:ring-1 focus-visible:ring-accent"
              >
                <XIcon className="size-3" />
              </button>
            </Chip>
          ))}
        </div>
      )}
      <div className="relative">
        <TagIcon className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-fg-subtle" />
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
          className="w-full rounded-lg border border-white/8 bg-white/5 py-1.5 pl-8 pr-3 text-sm text-fg placeholder:text-fg-subtle focus:border-accent/60 focus:outline-none focus:ring-2 focus:ring-accent/25"
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
        <span className="font-medium text-fg">{verifying ? "Verifying…" : `Downloading… ${pct}%`}</span>
        <button
          type="button"
          onClick={onCancel}
          className="cursor-pointer text-xs font-medium text-fg-muted transition-colors hover:text-fg focus:outline-none focus-visible:underline"
        >
          Cancel
        </button>
      </div>
      <ProgressTrack pct={verifying ? 100 : pct} className="h-2" />
      <p className="data mt-1.5 text-xs text-fg-subtle">
        {formatBytes(download.receivedBytes)} / {formatBytes(totalBytes)}
      </p>
    </div>
  );
}
