import {
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  RefreshCw,
  FolderPlus,
  FilePlus,
  Eye,
  EyeOff,
  Maximize2,
  Download,
  Upload,
  HardDriveUpload,
  Trash2,
  KeyRound,
  FileText,
  Terminal,
  FolderOpen,
  ExternalLink,
} from "lucide-react";
import type { ReactNode } from "react";
import { useT } from "../../lib/i18n";

interface FileToolbarProps {
  side: "local" | "remote";
  canBack: boolean;
  canForward: boolean;
  canUp: boolean;
  showHidden: boolean;
  loading?: boolean;
  selectionCount: number;
  canPreview?: boolean;
  onBack: () => void;
  onForward: () => void;
  onUp: () => void;
  onRefresh: () => void;
  onToggleHidden: () => void;
  onMkdir: () => void;
  onNewFile?: () => void;
  onDelete?: () => void;
  onChmod?: () => void;
  onPreview?: () => void;
  /** Remote pane: download selected files to local. Local pane: undefined. */
  onDownloadSelected?: () => void;
  /** Local pane: upload selected files to remote. Remote pane: undefined. */
  onUploadSelected?: () => void;
  /** Local pane only: open selected files/dirs with the system default app. */
  onOpenLocalSelected?: () => void;
  /** Local pane only: reveal the current directory in the OS file manager. */
  onRevealInOs?: () => void;
  /** Open OS file picker and upload to current dir (remote pane only in browser). */
  onUploadFromDisk?: () => void;
  /** Remote pane only: ask the parent terminal to `cd` into the current dir. */
  onOpenTerminalHere?: () => void;
  onDetach?: () => void;
  rightExtras?: ReactNode;
}

export function FileToolbar(props: FileToolbarProps) {
  const {
    side,
    canBack,
    canForward,
    canUp,
    showHidden,
    loading,
    selectionCount,
    canPreview,
    onBack,
    onForward,
    onUp,
    onRefresh,
    onToggleHidden,
    onMkdir,
    onNewFile,
    onDelete,
    onChmod,
    onPreview,
    onDownloadSelected,
    onUploadSelected,
    onOpenLocalSelected,
    onRevealInOs,
    onUploadFromDisk,
    onOpenTerminalHere,
    onDetach,
    rightExtras,
  } = props;

  const hasSelection = selectionCount > 0;
  const t = useT();

  return (
    <div
      className="h-7 flex items-center gap-0.5 px-1 border-b shrink-0 overflow-x-auto"
      style={{ borderColor: "var(--taomni-divider)", background: "var(--taomni-quick-bg)" }}
    >
      <ToolBtn testId={`sftp-${side}-back`} title={t("fileBrowser.back")} disabled={!canBack} onClick={onBack}>
        <ArrowLeft className="w-3.5 h-3.5" />
      </ToolBtn>
      <ToolBtn testId={`sftp-${side}-forward`} title={t("fileBrowser.forward")} disabled={!canForward} onClick={onForward}>
        <ArrowRight className="w-3.5 h-3.5" />
      </ToolBtn>
      <ToolBtn testId={`sftp-${side}-up`} title={t("fileBrowser.up")} disabled={!canUp} onClick={onUp}>
        <ArrowUp className="w-3.5 h-3.5" />
      </ToolBtn>
      <Sep />
      <ToolBtn testId={`sftp-${side}-refresh`} title={t("fileBrowser.refresh")} onClick={onRefresh}>
        <RefreshCw className={`w-3.5 h-3.5 ${loading ? "animate-spin" : ""}`} />
      </ToolBtn>

      {side === "remote" && onDownloadSelected && (
        <ToolBtn
          testId="sftp-remote-download-selected"
          title={hasSelection ? t("fileBrowser.download_count", { count: selectionCount }) : t("fileBrowser.download_default")}
          disabled={!hasSelection}
          onClick={onDownloadSelected}
        >
          <Download className="w-3.5 h-3.5" />
        </ToolBtn>
      )}
      {side === "local" && onUploadSelected && (
        <ToolBtn
          testId="sftp-local-upload-selected"
          title={hasSelection ? t("fileBrowser.upload_count", { count: selectionCount }) : t("fileBrowser.upload_default")}
          disabled={!hasSelection}
          onClick={onUploadSelected}
        >
          <Upload className="w-3.5 h-3.5" />
        </ToolBtn>
      )}
      {side === "remote" && onUploadFromDisk && (
        <ToolBtn testId="sftp-remote-upload-from-disk" title={t("fileBrowser.uploadFromDisk")} onClick={onUploadFromDisk}>
          <HardDriveUpload className="w-3.5 h-3.5" />
        </ToolBtn>
      )}
      {side === "local" && onOpenLocalSelected && (
        <ToolBtn
          testId="sftp-local-open-selected"
          title={
            hasSelection
              ? selectionCount === 1
                ? t("fileBrowser.openWithDefault")
                : t("fileBrowser.openCountWithDefault", { count: selectionCount })
              : t("fileBrowser.openSelectedDefault")
          }
          disabled={!hasSelection}
          onClick={onOpenLocalSelected}
        >
          <FolderOpen className="w-3.5 h-3.5" />
        </ToolBtn>
      )}
      {side === "local" && onRevealInOs && (
        <ToolBtn
          testId="sftp-local-reveal-in-os"
          title={t("fileBrowser.revealInOs")}
          onClick={onRevealInOs}
        >
          <ExternalLink className="w-3.5 h-3.5" />
        </ToolBtn>
      )}

      <Sep />
      <ToolBtn testId={`sftp-${side}-new-folder`} title={t("fileBrowser.newFolder")} onClick={onMkdir}>
        <FolderPlus className="w-3.5 h-3.5" />
      </ToolBtn>
      {onNewFile && (
        <ToolBtn testId={`sftp-${side}-new-file`} title={t("fileBrowser.newFile")} onClick={onNewFile}>
          <FilePlus className="w-3.5 h-3.5" />
        </ToolBtn>
      )}
      {onDelete && (
        <ToolBtn
          testId={`sftp-${side}-delete`}
          title={hasSelection ? t("fileBrowser.deleteCount", { count: selectionCount }) : t("fileBrowser.deleteSelected")}
          disabled={!hasSelection}
          onClick={onDelete}
          danger
        >
          <Trash2 className="w-3.5 h-3.5" />
        </ToolBtn>
      )}
      {onChmod && (
        <ToolBtn
          testId={`sftp-${side}-chmod`}
          title={
            selectionCount > 1
              ? t("fileBrowser.chmodSelectedTitle", { count: selectionCount })
              : t("fileBrowser.chmodTitle")
          }
          disabled={selectionCount === 0}
          onClick={onChmod}
        >
          <KeyRound className="w-3.5 h-3.5" />
        </ToolBtn>
      )}
      {onPreview && (
        <ToolBtn
          testId={`sftp-${side}-preview`}
          title={t("fileBrowser.previewFile")}
          disabled={!canPreview}
          onClick={onPreview}
        >
          <FileText className="w-3.5 h-3.5" />
        </ToolBtn>
      )}

      <Sep />
      <ToolBtn
        testId={`sftp-${side}-toggle-hidden`}
        title={showHidden ? t("fileBrowser.hideHidden") : t("fileBrowser.showHidden")}
        onClick={onToggleHidden}
        active={showHidden}
      >
        {showHidden ? <EyeOff className="w-3.5 h-3.5" /> : <Eye className="w-3.5 h-3.5" />}
      </ToolBtn>
      {side === "remote" && onOpenTerminalHere && (
        <ToolBtn testId="sftp-remote-open-terminal-here" title={t("fileBrowser.openTerminalAt")} onClick={onOpenTerminalHere}>
          <Terminal className="w-3.5 h-3.5" />
        </ToolBtn>
      )}
      {onDetach && (
        <ToolBtn testId={`sftp-${side}-detach`} title={t("fileBrowser.detachTitle")} onClick={onDetach}>
          <Maximize2 className="w-3.5 h-3.5" />
        </ToolBtn>
      )}
      <div className="flex-1" />
      {rightExtras}
    </div>
  );
}

function Sep() {
  return (
    <span
      className="inline-block h-4 mx-0.5 shrink-0"
      style={{ width: 1, background: "var(--taomni-divider)" }}
    />
  );
}

function ToolBtn({
  children,
  title,
  testId,
  onClick,
  disabled,
  active,
  danger,
}: {
  children: ReactNode;
  title: string;
  testId?: string;
  onClick: () => void;
  disabled?: boolean;
  active?: boolean;
  danger?: boolean;
}) {
  return (
    <button
      data-testid={testId}
      type="button"
      title={title}
      onClick={onClick}
      disabled={disabled}
      className="w-6 h-6 inline-flex items-center justify-center rounded shrink-0 hover:bg-[var(--taomni-hover)] disabled:opacity-30 disabled:cursor-default"
      style={{
        background: active ? "var(--taomni-selected)" : undefined,
        color: danger && !disabled ? "#c0392b" : undefined,
      }}
    >
      {children}
    </button>
  );
}
