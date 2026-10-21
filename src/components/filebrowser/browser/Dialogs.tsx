import { Columns, Rows } from "lucide-react";
import { useT, type TranslateFn } from "../../../lib/i18n";
import { joinPath, type FileEntry } from "../../../lib/sftp";
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
      <span className="text-[10px]">
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
    <div
      className="fixed inset-0 z-50 flex items-center justify-center"
      style={{ background: "rgba(0,0,0,0.4)" }}
      onClick={onCancel}
    >
      <div
        role="dialog"
        aria-modal="true"
        className="w-[420px] rounded shadow-lg p-4"
        style={{ background: "var(--taomni-bg)", border: "1px solid var(--taomni-card-border)" }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="text-sm font-semibold mb-2">{t("fileBrowser.downloadPromptTitle")}</div>
        <div className="text-[12px] mb-3 break-all" style={{ color: "var(--taomni-text-muted)" }}>
          {t("fileBrowser.downloadPromptDescription", { name: entry.name })}
          <div className="mt-1 font-mono text-[11px]">{joinPath(localDir, entry.name)}</div>
        </div>
        <div className="flex gap-2 justify-end">
          <button
            type="button"
            className="px-3 py-1 text-[12px] rounded hover:bg-[var(--taomni-hover)]"
            onClick={onCancel}
          >
            {t("fileBrowser.chmodCancel")}
          </button>
          <button
            type="button"
            className="px-3 py-1 text-[12px] rounded hover:bg-[var(--taomni-hover)]"
            onClick={() => onDownload(false)}
          >
            {t("fileBrowser.downloadPromptDownloadOnly")}
          </button>
          <button
            type="button"
            className="px-3 py-1 text-[12px] rounded text-white"
            style={{ background: "var(--taomni-accent)" }}
            onClick={() => onDownload(true)}
          >
            {t("fileBrowser.downloadPromptDownloadAndOpen")}
          </button>
        </div>
      </div>
    </div>
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
    <div
      className="fixed inset-0 z-50 flex items-center justify-center"
      style={{ background: "rgba(0,0,0,0.5)" }}
      onClick={onClose}
    >
      <div
        role="dialog"
        aria-modal="true"
        className="w-[80vw] h-[70vh] rounded shadow-lg flex flex-col"
        style={{ background: "var(--taomni-bg)", border: "1px solid var(--taomni-card-border)" }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="px-3 py-1.5 text-[12px] flex items-center border-b"
          style={{ borderColor: "var(--taomni-divider)", background: "var(--taomni-quick-bg)" }}>
          <span className="font-semibold">{name}</span>
          <span className="ml-2 text-[var(--taomni-text-muted)]">{path}</span>
          <div className="flex-1" />
          <button type="button" data-testid="sftp-preview-close" className="px-2 py-0.5 hover:bg-[var(--taomni-hover)] rounded" onClick={onClose}>
            {t("fileBrowser.previewClose")}
          </button>
        </div>
        <pre className="flex-1 overflow-auto px-3 py-2 text-[12px] font-mono whitespace-pre-wrap break-all"
          style={{ background: "var(--taomni-bg)", color: "var(--taomni-text)" }}>
          {text}
        </pre>
      </div>
    </div>
  );
}
