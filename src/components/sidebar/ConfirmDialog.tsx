import { useEffect, useRef } from "react";

export interface ConfirmDialogProps {
  title?: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}

// Drop-in replacement for window.confirm. Tauri 2's macOS WKWebView ignores
// window.confirm/alert by default, so any flow that relied on them silently
// no-ops on macOS. This in-app dialog renders as a normal React modal so it
// works uniformly on every platform without pulling in tauri-plugin-dialog.
export function ConfirmDialog({
  title = "Confirm",
  message,
  confirmLabel = "OK",
  cancelLabel = "Cancel",
  danger = false,
  onCancel,
  onConfirm,
}: ConfirmDialogProps) {
  const confirmRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    confirmRef.current?.focus();
  }, []);

  const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      event.stopPropagation();
      onCancel();
    } else if (event.key === "Enter") {
      const target = event.target as HTMLElement;
      if (target.tagName !== "BUTTON") {
        event.preventDefault();
        onConfirm();
      }
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center"
      style={{ background: "rgba(0,0,0,0.4)" }}
      onClick={onCancel}
      onKeyDown={handleKeyDown}
    >
      <div
        role="dialog"
        aria-label={title}
        aria-modal="true"
        data-testid="confirm-dialog"
        className="w-[420px] rounded shadow-lg p-4"
        style={{ background: "var(--moba-bg)", border: "1px solid var(--moba-card-border)" }}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="text-sm font-semibold mb-3">{title}</div>
        <div
          data-testid="confirm-dialog-message"
          className="text-[12px] mb-4 whitespace-pre-line"
          style={{ color: "var(--moba-text)" }}
        >
          {message}
        </div>
        <div className="flex gap-2 justify-end">
          <button
            type="button"
            data-testid="confirm-dialog-cancel"
            className="px-3 py-1 text-[12px] rounded hover:bg-[var(--moba-hover)]"
            onClick={onCancel}
          >
            {cancelLabel}
          </button>
          <button
            ref={confirmRef}
            type="button"
            data-testid="confirm-dialog-confirm"
            className="px-3 py-1 text-[12px] rounded text-white"
            style={{ background: danger ? "#b22222" : "var(--moba-accent)" }}
            onClick={onConfirm}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}
