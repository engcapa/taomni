import { useState } from "react";
import { Modal } from "../ui/Modal";
import { folderOptionLabel, normalizeGroupPath } from "../../lib/sessionPaths";
import { useT } from "../../lib/i18n";

export interface FolderNameDialogProps {
  parentPath: string | null;
  initialName?: string;
  title?: string;
  confirmLabel?: string;
  onCancel: () => void;
  onSubmit: (folderPath: string) => void;
}

export function FolderNameDialog({
  parentPath,
  initialName,
  title,
  confirmLabel,
  onCancel,
  onSubmit,
}: FolderNameDialogProps) {
  const t = useT();
  const resolvedTitle = title ?? t("sidebar.newFolder");
  const resolvedConfirm = confirmLabel ?? t("common.ok");
  const [name, setName] = useState(initialName ?? t("sidebar.newFolder"));

  const parentLabel = folderOptionLabel(parentPath);
  const trimmedName = name.trim();
  const composed = trimmedName ? `${parentLabel} / ${trimmedName}` : parentLabel;
  const normalized = normalizeGroupPath(composed);
  const valid = !!normalized && !!trimmedName;

  const handleSubmit = () => {
    if (!valid || !normalized) return;
    onSubmit(normalized);
  };

  return (
    <Modal testId="folder-name-dialog" title={resolvedTitle} initialFocus="input" onCancel={onCancel} footer={<>
      <button type="button" className="taomni-btn" data-testid="folder-name-dialog-cancel" onClick={onCancel}>
        {t("common.cancel")}
      </button>
      <button type="button" className="taomni-btn" data-primary="true" data-testid="folder-name-dialog-confirm"
        onClick={handleSubmit} disabled={!valid}>{resolvedConfirm}</button>
    </>}>
      <div
        className="flex items-stretch rounded overflow-hidden"
        style={{ border: "1px solid var(--taomni-input-border)", background: "var(--taomni-input-bg)" }}
      >
        <span
          data-testid="folder-name-dialog-parent"
          className="px-2 py-1 select-none whitespace-nowrap max-w-[180px] truncate"
          style={{ background: "var(--taomni-hover)", color: "var(--taomni-text-muted)" }}
          title={parentLabel}
        >
          {parentLabel} /
        </span>
        <input
          data-testid="folder-name-dialog-input"
          type="text"
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.nativeEvent.isComposing && event.nativeEvent.keyCode !== 229) {
              event.preventDefault();
              handleSubmit();
            }
          }}
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder={t("sidebar.folderNamePlaceholder")}
          className="flex-1 min-w-0 px-2 py-1"
          style={{ background: "transparent", color: "var(--taomni-text)" }}
          aria-label={t("sidebar.folderNamePlaceholder")}
        />
      </div>
    </Modal>
  );
}
