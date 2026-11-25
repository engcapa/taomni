import { Modal } from "./Modal";

type Props = {
  title: string;
  message: string;
  confirmLabel: string;
  cancelLabel: string;
  danger?: boolean;
  onCancel: () => void;
  onConfirm: () => void;
};

export function ConfirmDialog({ title, message, confirmLabel, cancelLabel, danger, onCancel, onConfirm }: Props) {
  return <Modal title={title} testId="confirm-dialog"
    initialFocus={danger ? '[data-testid="confirm-dialog-cancel"]' : '[data-testid="confirm-dialog-confirm"]'}
    onCancel={onCancel} footer={<>
      <button type="button" className="taomni-btn" data-testid="confirm-dialog-cancel" onClick={onCancel}>{cancelLabel}</button>
      <button type="button" className="taomni-btn" data-primary={!danger} data-danger={danger}
        data-testid="confirm-dialog-confirm" onClick={onConfirm}>{confirmLabel}</button>
    </>}>
    <p data-testid="confirm-dialog-message">{message}</p>
  </Modal>;
}
