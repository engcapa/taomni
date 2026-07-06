import { useCallback, useEffect, useId, useRef, useState, type ReactNode } from "react";
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

export type ChoiceDialogValue = "primary" | "secondary" | null;

export interface ChoiceDialogProps {
  title?: string;
  message: string;
  primaryLabel: string;
  secondaryLabel: string;
  cancelLabel?: string;
  danger?: boolean;
  onCancel: () => void;
  onPrimary: () => void;
  onSecondary: () => void;
}

export type ChoiceDialogOptions = Pick<
  ChoiceDialogProps,
  "title" | "message" | "primaryLabel" | "secondaryLabel" | "cancelLabel" | "danger"
>;

type PendingConfirmDialog = ConfirmDialogOptions & {
  resolve: (confirmed: boolean) => void;
};

export interface TextInputDialogProps {
  title: string;
  label?: string;
  initialValue?: string;
  placeholder?: string;
  allowEmpty?: boolean;
  confirmLabel?: string;
  cancelLabel?: string;
  onCancel: () => void;
  onConfirm: (value: string) => void;
}

export type TextInputDialogOptions = Pick<
  TextInputDialogProps,
  "title" | "label" | "initialValue" | "placeholder" | "allowEmpty" | "confirmLabel" | "cancelLabel"
>;

type PendingTextInputDialog = TextInputDialogOptions & {
  resolve: (value: string | null) => void;
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

export function useTextInputDialog(): {
  promptText: (options: TextInputDialogOptions) => Promise<string | null>;
  render: ReactNode;
} {
  const [pending, setPending] = useState<PendingTextInputDialog | null>(null);

  const promptText = useCallback((options: TextInputDialogOptions) => {
    return new Promise<string | null>((resolve) => {
      setPending((current) => {
        current?.resolve(null);
        return { ...options, resolve };
      });
    });
  }, []);

  const resolvePending = useCallback((value: string | null) => {
    setPending((current) => {
      current?.resolve(value);
      return null;
    });
  }, []);

  return {
    promptText,
    render: pending ? (
      <TextInputDialog
        title={pending.title}
        label={pending.label}
        initialValue={pending.initialValue}
        placeholder={pending.placeholder}
        allowEmpty={pending.allowEmpty}
        confirmLabel={pending.confirmLabel}
        cancelLabel={pending.cancelLabel}
        onCancel={() => resolvePending(null)}
        onConfirm={(value) => resolvePending(value)}
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
      className="fixed inset-0 z-[950] flex items-center justify-center"
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

export function ChoiceDialog({
  title,
  message,
  primaryLabel,
  secondaryLabel,
  cancelLabel,
  danger = false,
  onCancel,
  onPrimary,
  onSecondary,
}: ChoiceDialogProps) {
  const t = useT();
  const primaryRef = useRef<HTMLButtonElement>(null);
  const resolvedTitle = title ?? t("common.confirm");
  const resolvedCancel = cancelLabel ?? t("common.cancel");

  useEffect(() => {
    primaryRef.current?.focus();
  }, []);

  const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      event.stopPropagation();
      onCancel();
    } else if (event.key === "Enter") {
      const target = event.target as HTMLElement;
      if (target.tagName !== "BUTTON") {
        event.preventDefault();
        onPrimary();
      }
    }
  };

  return (
    <div
      className="fixed inset-0 z-[950] flex items-center justify-center"
      style={{ background: "rgba(0,0,0,0.4)" }}
      onClick={onCancel}
      onKeyDown={handleKeyDown}
    >
      <div
        role="dialog"
        aria-label={resolvedTitle}
        aria-modal="true"
        data-testid="choice-dialog"
        className="w-[460px] rounded shadow-lg p-4"
        style={{ background: "var(--taomni-bg)", border: "1px solid var(--taomni-card-border)" }}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="text-sm font-semibold mb-3">{resolvedTitle}</div>
        <div
          data-testid="choice-dialog-message"
          className="text-[12px] mb-4 whitespace-pre-line"
          style={{ color: "var(--taomni-text)" }}
        >
          {message}
        </div>
        <div className="flex gap-2 justify-end">
          <button
            type="button"
            data-testid="choice-dialog-cancel"
            className="px-3 py-1 text-[12px] rounded hover:bg-[var(--taomni-hover)]"
            onClick={onCancel}
          >
            {resolvedCancel}
          </button>
          <button
            type="button"
            data-testid="choice-dialog-secondary"
            className="px-3 py-1 text-[12px] rounded hover:bg-[var(--taomni-hover)]"
            style={{ border: "1px solid var(--taomni-divider)" }}
            onClick={onSecondary}
          >
            {secondaryLabel}
          </button>
          <button
            ref={primaryRef}
            type="button"
            data-testid="choice-dialog-primary"
            className="px-3 py-1 text-[12px] rounded text-white"
            style={{ background: danger ? "#b22222" : "var(--taomni-accent)" }}
            onClick={onPrimary}
          >
            {primaryLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

// Async replacement for window.prompt for the same macOS WKWebView reason as
// ConfirmDialog above.
export function TextInputDialog({
  title,
  label,
  initialValue = "",
  placeholder,
  allowEmpty = false,
  confirmLabel,
  cancelLabel,
  onCancel,
  onConfirm,
}: TextInputDialogProps) {
  const t = useT();
  const inputId = useId();
  const inputRef = useRef<HTMLInputElement>(null);
  const [value, setValue] = useState(initialValue);
  const resolvedConfirm = confirmLabel ?? t("common.ok");
  const resolvedCancel = cancelLabel ?? t("common.cancel");
  const canConfirm = allowEmpty || value.trim().length > 0;

  useEffect(() => {
    setValue(initialValue);
  }, [initialValue]);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  const submit = () => {
    if (!canConfirm) return;
    onConfirm(value);
  };

  const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape") {
      event.stopPropagation();
      onCancel();
    } else if (event.key === "Enter") {
      if ((event.nativeEvent as KeyboardEvent).isComposing) return;
      event.preventDefault();
      submit();
    }
  };

  return (
    <div
      className="fixed inset-0 z-[950] flex items-center justify-center"
      style={{ background: "rgba(0,0,0,0.4)" }}
      onClick={onCancel}
      onKeyDown={handleKeyDown}
    >
      <div
        role="dialog"
        aria-label={title}
        aria-modal="true"
        data-testid="text-input-dialog"
        className="w-[420px] rounded shadow-lg p-4"
        style={{ background: "var(--taomni-bg)", border: "1px solid var(--taomni-card-border)" }}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="text-sm font-semibold mb-3">{title}</div>
        <label
          htmlFor={inputId}
          className="block text-[12px] mb-1"
          style={{ color: "var(--taomni-text-muted)" }}
        >
          {label ?? title}
        </label>
        <input
          ref={inputRef}
          id={inputId}
          data-testid="text-input-dialog-input"
          className="taomni-input w-full mb-4"
          value={value}
          placeholder={placeholder}
          onChange={(event) => setValue(event.target.value)}
        />
        <div className="flex gap-2 justify-end">
          <button
            type="button"
            data-testid="text-input-dialog-cancel"
            className="px-3 py-1 text-[12px] rounded hover:bg-[var(--taomni-hover)]"
            onClick={onCancel}
          >
            {resolvedCancel}
          </button>
          <button
            type="button"
            data-testid="text-input-dialog-confirm"
            className="px-3 py-1 text-[12px] rounded text-white disabled:opacity-50"
            style={{ background: "var(--taomni-accent)" }}
            onClick={submit}
            disabled={!canConfirm}
          >
            {resolvedConfirm}
          </button>
        </div>
      </div>
    </div>
  );
}

export interface AlertDialogProps {
  title?: string;
  message: string;
  okLabel?: string;
  onClose: () => void;
}

export function AlertDialog({ title, message, okLabel, onClose }: AlertDialogProps) {
  const t = useT();
  const okRef = useRef<HTMLButtonElement>(null);
  const resolvedTitle = title ?? t("common.message");
  const resolvedOk = okLabel ?? t("common.ok");

  useEffect(() => {
    okRef.current?.focus();
  }, []);

  const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "Escape" || event.key === "Enter") {
      event.preventDefault();
      event.stopPropagation();
      onClose();
    }
  };

  return (
    <div
      className="fixed inset-0 z-[950] flex items-center justify-center"
      style={{ background: "rgba(0,0,0,0.4)" }}
      onClick={onClose}
      onKeyDown={handleKeyDown}
    >
      <div
        role="alertdialog"
        aria-label={resolvedTitle}
        aria-modal="true"
        data-testid="alert-dialog"
        className="w-[420px] rounded shadow-lg p-4"
        style={{ background: "var(--taomni-bg)", border: "1px solid var(--taomni-card-border)" }}
        onClick={(event) => event.stopPropagation()}
      >
        <div className="text-sm font-semibold mb-3">{resolvedTitle}</div>
        <div
          data-testid="alert-dialog-message"
          className="text-[12px] mb-4 whitespace-pre-line"
          style={{ color: "var(--taomni-text)" }}
        >
          {message}
        </div>
        <div className="flex gap-2 justify-end">
          <button
            ref={okRef}
            type="button"
            data-testid="alert-dialog-ok"
            className="px-3 py-1 text-[12px] rounded text-white"
            style={{ background: "var(--taomni-accent)" }}
            onClick={onClose}
          >
            {resolvedOk}
          </button>
        </div>
      </div>
    </div>
  );
}
