import { Columns, Rows } from "lucide-react";
import { useT, type TranslateFn } from "../../../lib/i18n";
import { joinPath, type FileEntry } from "../../../lib/sftp";
import { Modal } from "../../ui/Modal";
import { type Orientation } from "./types";

export function OrientationToggle({
  orientation,
  onChange,
  t,
}: {
  orientation: Orientation;
  onChange: (next: Orientation) => void;
  t: TranslateFn;
}) {
  const next: Orientation = orientation === "horizontal" ? "vertical" : "horizontal";
  return (
    <button
      data-testid="sftp-orientation-toggle"
      type="button"
      className="px-1.5 py-0.5 inline-flex items-center gap-1 rounded hover:bg-[var(--taomni-hover)] shrink-0"
      title={
        orientation === "horizontal"
          ? t("fileBrowser.orientationToggleStackTitle")
          : t("fileBrowser.orientationToggleSideTitle")
      }
      onClick={() => onChange(next)}
      style={{ color: "var(--taomni-text-muted)" }}
    >
      {orientation === "horizontal" ? (
        <Columns className="w-3 h-3" />
      ) : (
        <Rows className="w-3 h-3" />
      )}
      <span className="text-ui-caption">
        {orientation === "horizontal" ? t("fileBrowser.orientationSide") : t("fileBrowser.orientationStack")}
      </span>
    </button>
  );
}

export function DownloadPrompt({
  entry,
  localDir,
  onCancel,
  onDownload,
}: {
  entry: FileEntry;
  localDir: string;
  onCancel: () => void;
  onDownload: (openAfter: boolean) => void;
}) {
  const t = useT();
  return (
    <Modal
      title={t("fileBrowser.downloadPromptTitle")}
      testId="sftp-download-prompt"
      closeLabel={t("common.close")}
      initialFocus='[data-testid="sftp-download-prompt-open"]'
      dismissOnBackdrop={true}
      onCancel={onCancel}
      footer={
        <>
          <button
            type="button"
            data-testid="sftp-download-prompt-cancel"
            className="taomni-btn"
            onClick={onCancel}
          >
            {t("fileBrowser.chmodCancel")}
          </button>
          <button
            type="button"
            data-testid="sftp-download-prompt-download"
            className="taomni-btn"
            onClick={() => onDownload(false)}
          >
            {t("fileBrowser.downloadPromptDownloadOnly")}
          </button>
          <button
            type="button"
            data-testid="sftp-download-prompt-open"
            className="taomni-btn"
            data-primary="true"
            onClick={() => onDownload(true)}
          >
            {t("fileBrowser.downloadPromptDownloadAndOpen")}
          </button>
        </>
      }
    >
      <div className="text-ui-body break-all" style={{ color: "var(--taomni-text-muted)" }}>
        {t("fileBrowser.downloadPromptDescription", { name: entry.name })}
        <div className="mt-1 font-mono text-ui-small">{joinPath(localDir, entry.name)}</div>
      </div>
    </Modal>
  );
}

export function PreviewModal({
  path,
  name,
  text,
  onClose,
}: {
  path: string;
  name: string;
  text: string;
  onClose: () => void;
}) {
  const t = useT();
  return (
    <Modal
      size="complex"
      title={name}
      testId="sftp-preview-modal"
      initialFocus='[data-testid="sftp-preview-close"]'
      dismissOnBackdrop={true}
      onCancel={onClose}
      footer={
        <button
          type="button"
          data-testid="sftp-preview-close"
          className="taomni-btn"
          data-primary="true"
          onClick={onClose}
        >
          {t("fileBrowser.previewClose")}
        </button>
      }
    >
      <div className="mb-2 font-mono text-ui-small break-all text-[var(--taomni-text-muted)]">
        {path}
      </div>
      <pre
        className="h-[60vh] overflow-auto rounded border p-3 text-ui-body font-mono whitespace-pre-wrap break-all"
        style={{
          background: "var(--taomni-bg)",
          color: "var(--taomni-text)",
          borderColor: "var(--taomni-divider)",
        }}
      >
        {text}
      </pre>
    </Modal>
  );
}
