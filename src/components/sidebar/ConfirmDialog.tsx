import { ConfirmDialog as LabelledConfirmDialog } from "../../../src-tauri/crates/taomni-plugin-api/frontend/ui/ConfirmDialog";
import { useCallback, useId, useState, type ReactNode } from "react";
import { Modal } from "../ui/Modal";
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
    if (typeof window !== "undefined" && typeof (window as unknown as { __seeded_confirm?: boolean }).__seeded_confirm === "boolean") {
      return Promise.resolve((window as unknown as { __seeded_confirm?: boolean }).__seeded_confirm!);
    }
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
    const win = typeof window !== "undefined" ? (window as unknown as { __seeded_prompts?: string[] }) : undefined;
    if (win && Array.isArray(win.__seeded_prompts) && win.__seeded_prompts.length > 0) {
      return Promise.resolve(win.__seeded_prompts.shift() ?? null);
    }
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

export function ConfirmDialog({ title, message, confirmLabel, cancelLabel, danger, onCancel, onConfirm }: ConfirmDialogProps) {
  const t = useT();
  return <LabelledConfirmDialog title={title ?? t("common.confirm")} message={message}
    cancelLabel={cancelLabel ?? t("common.cancel")} confirmLabel={confirmLabel ?? t("common.ok")}
    danger={danger} onCancel={onCancel} onConfirm={onConfirm} />;
}

export function ChoiceDialog({ title, message, primaryLabel, secondaryLabel, cancelLabel, danger, onCancel, onPrimary, onSecondary }: ChoiceDialogProps) {
  const t = useT();
  return <Modal title={title ?? t("common.confirm")} testId="choice-dialog"
    initialFocus={danger ? '[data-testid="choice-dialog-cancel"]' : '[data-testid="choice-dialog-primary"]'}
    onCancel={onCancel} footer={<>
      <button type="button" className="taomni-btn" data-testid="choice-dialog-cancel" onClick={onCancel}>{cancelLabel ?? t("common.cancel")}</button>
      <button type="button" className="taomni-btn" data-testid="choice-dialog-secondary" onClick={onSecondary}>{secondaryLabel}</button>
      <button type="button" className="taomni-btn" data-primary={!danger} data-danger={danger}
        data-testid="choice-dialog-primary" onClick={onPrimary}>{primaryLabel}</button>
    </>}>
    <p data-testid="choice-dialog-message">{message}</p>
  </Modal>;
}

export function TextInputDialog({ title, label, initialValue = "", placeholder, allowEmpty = false,
  confirmLabel, cancelLabel, onCancel, onConfirm }: TextInputDialogProps) {
  const t = useT();
  const inputId = useId();
  const [value, setValue] = useState(initialValue);
  const canConfirm = allowEmpty || value.trim().length > 0;
  return <Modal title={title} testId="text-input-dialog" initialFocus="input" onCancel={onCancel} footer={<>
    <button type="button" className="taomni-btn" data-testid="text-input-dialog-cancel" onClick={onCancel}>{cancelLabel ?? t("common.cancel")}</button>
    <button type="button" className="taomni-btn" data-primary="true" data-testid="text-input-dialog-confirm"
      disabled={!canConfirm} onClick={() => onConfirm(value)}>{confirmLabel ?? t("common.ok")}</button>
  </>}>
    <label htmlFor={inputId}>{label ?? title}</label>
    <input id={inputId} className="taomni-input w-full" data-testid="text-input-dialog-input" value={value}
      placeholder={placeholder} onChange={(event) => setValue(event.target.value)} onKeyDown={(event) => {
        if (event.key !== "Enter" || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
        event.preventDefault();
        if (canConfirm) onConfirm(value);
      }} />
  </Modal>;
}

export type AlertDialogTone = "default" | "success" | "error";

export interface AlertDialogProps {
  title?: string;
  message: string;
  okLabel?: string;
  tone?: AlertDialogTone;
  onClose: () => void;
}

export function AlertDialog({ title, message, okLabel, tone = "default", onClose }: AlertDialogProps) {
  const t = useT();
  return <Modal title={title ?? t("common.message")} role="alertdialog" testId="alert-dialog" initialFocus="button"
    tone={tone} onCancel={onClose} footer={
      <button type="button" data-testid="alert-dialog-ok" className="taomni-btn" data-primary="true" onClick={onClose}>{okLabel ?? t("common.ok")}</button>
    }>
    <p data-testid="alert-dialog-message" className="taomni-mono">{message}</p>
  </Modal>;
}
