import { useRef } from "react";
import { useT } from "../../../lib/i18n";
import { Modal } from "../../ui/Modal";

interface UndoWorkspaceEditConfirmDialogProps {
  label: string | null;
  returnFocusTo: HTMLElement | null;
  onCancel: () => void;
  onConfirm: () => void;
}

export function UndoWorkspaceEditConfirmDialog({
  label,
  returnFocusTo,
  onCancel,
  onConfirm,
}: UndoWorkspaceEditConfirmDialogProps) {
  const t = useT();
  const settled = useRef(false);
  const settle = (decision: () => void) => {
    if (settled.current) return;
    settled.current = true;
    decision();
  };

  return <Modal title={t("workspaceUndo.title")} testId="code-workspace-undo-confirm"
    initialFocus='[data-testid="code-workspace-undo-confirm-ok"]' returnFocus={returnFocusTo}
    onCancel={() => settle(onCancel)}
    footer={<>
      <button type="button" data-testid="code-workspace-undo-confirm-cancel" className="taomni-btn"
        onClick={() => settle(onCancel)}>{t("common.cancel")}</button>
      <button type="button" data-testid="code-workspace-undo-confirm-ok" className="taomni-btn" data-primary="true"
        onClick={() => settle(onConfirm)}>{t("workspaceUndo.title")}</button>
    </>}>
    <p>{t("workspaceUndo.question", { edit: label ?? t("workspaceUndo.edit") })}</p>
  </Modal>;
}
