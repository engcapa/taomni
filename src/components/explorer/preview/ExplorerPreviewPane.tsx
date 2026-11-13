import { useState } from "react";
import { Settings, X } from "lucide-react";
import { writeText } from "../../../lib/clipboard";
import { basename, formatBytes, sftpOpenPath, type FileEntry } from "../../../lib/sftp";
import { useContextMenu } from "../../ContextMenu";
import { ExplorerFileIcon } from "../ExplorerFileIcon";
import { useExplorerLabels } from "../explorerLabels";
import { setExplorerPreferences, useExplorerPreferences } from "../explorerPreferences";
import { CsvFilePreview, MarkdownFilePreview, TextPreview } from "./PreviewContent";
import { useExplorerPreview } from "./useExplorerPreview";
import "./preview.css";

export interface ExplorerPreviewPaneProps {
  entries: FileEntry[];
  currentPath: string;
  tabId: string;
  onOpen: (entry: FileEntry) => void;
  onClose: () => void;
}

export function ExplorerPreviewPane({ entries, currentPath, tabId, onOpen, onClose }: ExplorerPreviewPaneProps) {
  const label = useExplorerLabels();
  const preferences = useExplorerPreferences();
  const preview = useExplorerPreview(entries, currentPath, tabId);
  const menu = useContextMenu();
  const [actionError, setActionError] = useState<{ key: string; message: string } | null>(null);
  const entry = entries.length === 1 ? entries[0] : undefined;
  const properties = preview.properties?.[0];
  const displayedSize = entries.reduce((sum, item) => {
    const recursive = preview.properties?.find((value) => value.path === item.path);
    return sum + (recursive?.size ?? item.size);
  }, 0);
  const directorySize = properties?.size;
  const lowerBound = preview.truncated || (preview.propertyErrors?.length ?? 0) > 0;
  const totalSize = `${lowerBound ? "≥ " : ""}${formatBytes(displayedSize)}`;

  const perform = (action: () => Promise<unknown>) => {
    const key = preview.key;
    setActionError(null);
    void action().catch((error) => {
      setActionError({ key, message: error instanceof Error ? error.message : String(error) });
    });
  };
  const settings = (event: React.MouseEvent<HTMLButtonElement>) => {
    const rectangle = event.currentTarget.getBoundingClientRect();
    menu.showAt(rectangle.left - 170, rectangle.bottom + 4, [
      { label: label("预览窗格位置", "Preview pane position"), disabled: true },
      { label: label("右侧", "Right"), testId: "explorer-preview-right", checked: preferences.previewPosition === "right", onClick: () => setExplorerPreferences({ previewPosition: "right" }) },
      { label: label("底部", "Bottom"), testId: "explorer-preview-bottom", checked: preferences.previewPosition === "bottom", onClick: () => setExplorerPreferences({ previewPosition: "bottom" }) },
      { label: "", separator: true },
      { label: label("文本预览", "Text preview"), disabled: true },
      { label: label("自动换行", "Word wrap"), testId: "explorer-preview-wrap", checked: preferences.wrap, onClick: () => setExplorerPreferences({ wrap: !preferences.wrap }) },
      { label: label("大小上限：256 KB", "Size limit: 256 KB"), checked: true, disabled: true },
      { label: "", separator: true },
      { label: label("设置会保存，并应用到所有 Explorer 标签", "Saved for all Explorer tabs"), disabled: true },
    ]);
  };

  const typeLabel = entry?.fileType === "dir"
    ? label("文件夹", "Folder")
    : entry?.fileType === "symlink"
      ? label("符号链接", "Symbolic link")
      : preview.kind === "markdown"
        ? "Markdown"
        : preview.kind === "csv"
          ? "CSV"
          : preview.kind === "image" || preview.kind === "too-large"
            ? label("图片", "Image")
            : label("文件", "File");

  return (
    <aside
      data-testid="explorer-preview"
      data-preview-kind={preview.kind}
      data-position={preferences.previewPosition}
      aria-label={label("预览", "Preview")}
      className="ex-pv"
      style={preferences.previewPosition === "right" ? { width: preferences.previewWidth } : undefined}
    >
      <div className="ex-pv-hd">
        <span>{label("预览", "Preview")}</span>
        <span className="ex-pv-spacer" />
        <button type="button" className="ex-pv-ibtn" data-testid="explorer-preview-settings" title={label("预览选项", "Preview options")} onClick={settings}><Settings /></button>
        <button type="button" className="ex-pv-ibtn" data-testid="explorer-preview-close" title={label("关闭预览 (Alt+P)", "Close preview (Alt+P)")} onClick={onClose}><X /></button>
      </div>
      <div className="ex-pv-body">
        {entries.length === 0 ? (
          <div className="ex-pv-none" data-testid="explorer-preview-metadata">
            <ExplorerFileIcon directory className="ex-pv-empty-icon" />
            <div className="ex-pv-current-name">{basename(currentPath) || currentPath}</div>
            <div>{preview.childCount === undefined ? "—" : preview.childCount} {label("个项目", "items")} · {directorySize === undefined ? "—" : `${lowerBound ? "≥ " : ""}${formatBytes(directorySize)}`}</div>
            <br />
            <div>{label("选择文件以预览", "Select a file to preview")}</div>
            <span className="ex-pv-supported">{label("文本 / Markdown / 图片 / CSV", "Text / Markdown / Images / CSV")}</span>
          </div>
        ) : entries.length > 1 ? (
          <div data-testid="explorer-preview-metadata">
            <div className="ex-pv-hero"><ExplorerFileIcon directory className="ex-pv-hero-icon" /><div className="ex-pv-name">{label(`已选择 ${entries.length} 项`, `${entries.length} items selected`)}</div></div>
            <dl className="ex-pv-meta">
              <dt>{label("文件", "Files")}</dt><dd>{entries.filter((item) => item.fileType !== "dir").length}</dd>
              <dt>{label("文件夹", "Folders")}</dt><dd>{entries.filter((item) => item.fileType === "dir").length}</dd>
              <dt>{label("总大小", "Total size")}</dt><dd>{totalSize}</dd>
            </dl>
          </div>
        ) : entry && (
          <>
            <div className="ex-pv-summary" data-testid="explorer-preview-metadata">
              <div className="ex-pv-hero"><ExplorerFileIcon entry={entry} className="ex-pv-hero-icon" /><div><div className="ex-pv-name">{entry.name}</div><div className="ex-pv-type">{typeLabel}</div></div></div>
              <dl className="ex-pv-meta">
                <dt>{label("大小", "Size")}</dt><dd>{entry.fileType === "dir" ? `${directorySize === undefined ? "—" : `${lowerBound ? "≥ " : ""}${formatBytes(directorySize)}`} · ${properties?.itemCount ?? "—"} ${label("项", "items")}` : formatBytes(entry.size)}</dd>
                <dt>{label("修改日期", "Modified")}</dt><dd>{entry.mtime ? new Date(entry.mtime * 1000).toLocaleString() : "—"}</dd>
                <dt>{label("位置", "Location")}</dt><dd className="ex-pv-location">{currentPath}</dd>
                {entry.symlinkTarget && <><dt>{label("链接目标", "Link target")}</dt><dd className="ex-pv-location">{entry.symlinkTarget}</dd></>}
              </dl>
            </div>
            <div className="ex-pv-content">
              {preview.kind === "text" && preview.text !== undefined && <TextPreview text={preview.text} wrap={preferences.wrap} />}
              {preview.kind === "markdown" && preview.text !== undefined && <MarkdownFilePreview text={preview.text} />}
              {preview.kind === "csv" && preview.text !== undefined && <CsvFilePreview text={preview.text} rowsLabel={label("仅显示前 100 行", "Showing the first 100 rows")} />}
              {preview.kind === "image" && preview.imageUrl && <div className="ex-pv-img"><img data-testid="explorer-preview-image" src={preview.imageUrl} alt={entry.name} onError={() => setActionError({ key: preview.key, message: label("无法解码此图片", "Unable to decode this image") })} /></div>}
              {preview.kind === "directory" && preview.children && <div className="ex-pv-directory">{preview.children.length > 0 ? preview.children.map((child) => <div key={child.path}><ExplorerFileIcon entry={child} className="ex-pv-child-icon" /><span>{child.name}</span></div>) : <span className="ex-pv-hint">{label("（空）", "(Empty)")}</span>}</div>}
              {preview.kind === "metadata" && <div className="ex-pv-none">{label("此类型暂无内容预览", "Content preview is not available for this file type")}<br /><span>{label("可用系统默认应用打开", "Open with the system default application")}</span></div>}
              {preview.kind === "binary" && <div className="ex-pv-none">{label("二进制文件不提供文本预览", "Binary files cannot be previewed as text")}</div>}
              {preview.kind === "too-large" && <div className="ex-pv-none">{label("图片超过预览上限（20 MB）", "Image exceeds the preview limit (20 MB)")}<br />{label("可用系统默认应用打开", "Open with the system default application")}</div>}
              {preview.text !== undefined && <div className="ex-pv-hint">UTF-8 · {label(`预览上限 256 KB`, "Preview limit 256 KB")}</div>}
            </div>
            <div className="ex-pv-actions">
              <button type="button" className="ex-pv-btn ex-pv-btn-primary" data-testid="explorer-preview-open" onClick={() => onOpen(entry)}>{label("打开", "Open")}</button>
              <button type="button" className="ex-pv-btn" data-testid="explorer-preview-system" onClick={() => perform(() => sftpOpenPath(entry.path))}>{label("系统应用", "System app")}</button>
              <button type="button" className="ex-pv-btn" data-testid="explorer-preview-copy-path" onClick={() => perform(() => writeText(entry.path))}>{label("复制路径", "Copy path")}</button>
            </div>
          </>
        )}
        {preview.loading && <div className="ex-pv-hint" data-testid="explorer-preview-loading" role="status">{label("正在加载预览…", "Loading preview…")}</div>}
        {preview.truncated && <div className="ex-pv-hint" data-testid="explorer-preview-truncated">{preview.text !== undefined ? label("已截断，仅显示前 256 KB", "Truncated: showing the first 256 KB") : label("大小统计已达到限制，显示已读取部分", "Size calculation reached its limit; showing the counted portion")}</div>}
        {preview.error && <div className="ex-pv-error" data-testid="explorer-preview-error" role="alert">{label("无法加载预览：", "Unable to load preview: ")}{preview.error}</div>}
        {(preview.propertyErrors?.length ?? 0) > 0 && <div className="ex-pv-error" role="alert">{preview.propertyErrors?.join("\n")}</div>}
        {actionError?.key === preview.key && <div className="ex-pv-error" data-testid="explorer-preview-action-error" role="alert">{actionError.message}</div>}
      </div>
      {menu.render}
    </aside>
  );
}
