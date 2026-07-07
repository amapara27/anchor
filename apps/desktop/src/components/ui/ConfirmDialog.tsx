import { useEffect, useRef } from "react";
import { Button } from "./Button";

/**
 * In-app confirmation dialog for destructive actions. `window.confirm` is not
 * implemented in Tauri's WKWebView (it silently returns false), so this is the
 * one confirm path — used by DiskPage and the model detail drawer.
 */
export function ConfirmDialog({
  open,
  title,
  body,
  confirmLabel,
  onConfirm,
  onCancel,
}: {
  open: boolean;
  title: string;
  body: string;
  confirmLabel: string;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const panelRef = useRef<HTMLDivElement>(null);

  // Escape cancels; focus the panel on open (a11y: escape-routes + focus).
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onCancel();
    };
    document.addEventListener("keydown", onKey);
    panelRef.current?.focus();
    return () => document.removeEventListener("keydown", onKey);
  }, [open, onCancel]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center px-4"
      role="alertdialog"
      aria-modal="true"
      aria-label={title}
    >
      <div className="absolute inset-0 bg-black/60" onClick={onCancel} aria-hidden />
      <div
        ref={panelRef}
        tabIndex={-1}
        className="relative w-full max-w-sm rounded-[var(--radius-card)] border border-[var(--hairline-strong)] bg-surface p-5 shadow-overlay outline-none"
      >
        <h2 className="text-base font-semibold text-fg">{title}</h2>
        <p className="mt-1.5 text-sm leading-relaxed text-fg-muted">{body}</p>
        <div className="mt-5 flex justify-end gap-2">
          <Button variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
          <button
            type="button"
            onClick={onConfirm}
            className="inline-flex cursor-pointer items-center justify-center gap-1.5 rounded-[var(--radius-control)] border border-danger/30 bg-danger/10 px-3 py-1.5 text-sm font-medium text-danger transition-colors hover:bg-danger/15 focus:outline-none focus-visible:ring-2 focus-visible:ring-danger/40"
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
