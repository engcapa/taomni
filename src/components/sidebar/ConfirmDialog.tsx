import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { useT } from "../../lib/i18n";

export interface ConfirmDialogProps {
  title?: string;
  message: string;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}

export type ConfirmDialogOptions = Pick<
  ConfirmDialogProps,
  "title" | "message" | "confirmLabel" | "cancelLabel" | "danger"
>;

type PendingConfirmDialog = ConfirmDialogOptions & {
  resolve: (confirmed: boolean) => void;
};

export function useConfirmDialog(): {
  confirm: (options: ConfirmDialogOptions) => Promise<boolean>;
  render: ReactNode;
} {
  const [pending, setPending] = useState<PendingConfirmDialog | null>(null);

  const confirm = useCallback((options: ConfirmDialogOptions) => {
    return new Promise<boolean>((resolve) => {
      setPending((current) => {
        current?.resolve(false);
        return { ...options, resolve };
      });
    });
  }, []);

  const resolvePending = useCallback((confirmed: boolean) => {
    setPending((current) => {
      current?.resolve(confirmed);
      return null;
    });
  }, []);

  return {
    confirm,
    render: pending ? (
      <ConfirmDialog
        title={pending.title}
        message={pending.message}
        confirmLabel={pending.confirmLabel}
        cancelLabel={pending.cancelLabel}
        danger={pending.danger}
        onCancel={() => resolvePending(false)}
        onConfirm={() => resolvePending(true)}
      />
    ) : null,
  };
}

// Drop-in replacement for window.confirm. Tauri 2's macOS WKWebView ignores
// window.confirm/alert by default, so any flow that relied on them silently
// no-ops on macOS. This in-app dialog renders as a normal React modal so it
// works uniformly on every platform without pulling in tauri-plugin-dialog.
export function ConfirmDialog({
  title,
  message,
  confirmLabel,
  cancelLabel,
  danger = false,
  onCancel,
  onConfirm,
}: ConfirmDialogProps) {
  const t = useT();
  const confirmRef = useRef<HTMLButtonElement>(null);
  const resolvedTitle = title ?? t("common.confirm");
  const resolvedConfirm = confirmLabel ?? t("common.ok");
  const resolvedCancel = cancelLabel ?? t("common.cancel");

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
        aria-label={resolvedTitle}
        aria-modal="true"
        data-testid="confirm-dialog"
        className="w-[420px] rounded shadow-lg p-4"
        style={{ background: "var(--taomni-bg)", border: "1px solid var(--taomni-card-border)" }}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="text-sm font-semibold mb-3">{resolvedTitle}</div>
        <div
          data-testid="confirm-dialog-message"
          className="text-[12px] mb-4 whitespace-pre-line"
          style={{ color: "var(--taomni-text)" }}
        >
          {message}
        </div>
        <div className="flex gap-2 justify-end">
          <button
            type="button"
            data-testid="confirm-dialog-cancel"
            className="px-3 py-1 text-[12px] rounded hover:bg-[var(--taomni-hover)]"
            onClick={onCancel}
          >
            {resolvedCancel}
          </button>
          <button
            ref={confirmRef}
            type="button"
            data-testid="confirm-dialog-confirm"
            className="px-3 py-1 text-[12px] rounded text-white"
            style={{ background: danger ? "#b22222" : "var(--taomni-accent)" }}
            onClick={onConfirm}
          >
            {resolvedConfirm}
          </button>
        </div>
      </div>
    </div>
  );
}
