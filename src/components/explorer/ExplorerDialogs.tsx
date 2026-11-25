import { useEffect, useRef, useState } from "react";
import { explorerCancelOperation, localProperties, type LocalProperties } from "../../lib/explorer";
import { formatBytes, formatPosixMode, type FileEntry } from "../../lib/sftp";
import { useFocusReturn } from "../editor/workspace/useFocusReturn";
import { useExplorerLabels } from "./explorerLabels";
import type { ExplorerOperations } from "./useExplorerOperations";
import { ExplorerNewFileDialog } from "./ExplorerNewFileDialog";

function ExplorerDialog({ children, onClose, testId, focusTestId }: { children: React.ReactNode; onClose: () => void; testId: string; focusTestId?: string }) {
  useFocusReturn(true);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const scoped = focusTestId ? ref.current?.querySelector<HTMLButtonElement>(`[data-testid="${focusTestId}"]`) : null;
    (scoped ?? ref.current?.querySelector<HTMLButtonElement>("button"))?.focus();
  }, [focusTestId]);
  return <div className="ex-dialog-back" onPointerDown={(event) => event.stopPropagation()}>
    <div ref={ref} className="ex-dialog" data-testid={testId} role="dialog" aria-labelledby={testId + "-title"} aria-modal="true" tabIndex={-1} onKeyDown={(event) => {
      event.stopPropagation();
      if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
      if (event.key === "Escape") { event.preventDefault(); onClose(); }
      if (event.key === "Tab") {
        const buttons = Array.from(ref.current?.querySelectorAll<HTMLElement>("button:enabled,input:enabled,[tabindex='0']") ?? []);
        if (!buttons.length) return;
        const index = buttons.indexOf(document.activeElement as HTMLElement);
        const next = event.shiftKey ? (index - 1 + buttons.length) % buttons.length : (index + 1) % buttons.length;
        event.preventDefault(); buttons[next].focus();
      }
    }}>{children}</div>
  </div>;
}
function PropertiesDialog({ entries, onClose }: { entries: FileEntry[]; onClose: () => void }) {
  const label = useExplorerLabels();
  const [properties, setProperties] = useState<LocalProperties[]>([]);
  const [error, setError] = useState("");
  useEffect(() => {
    let disposed = false;
    const ids = entries.map(() => `properties-${crypto.randomUUID()}`);
    // Process sequentially so selecting a huge directory set does not flood blocking workers.
    void (async () => {
      for (let index = 0; index < entries.length; index++) {
        try {
          const result = await localProperties(entries[index].path, ids[index]);
          if (disposed) return;
          setProperties((old) => [...old, result]);
        } catch (reason) { if (!disposed) setError((old) => [old, String(reason)].filter(Boolean).join("\n")); }
        if (disposed) return;
      }
    })();
    return () => { disposed = true; ids.forEach((id) => { void explorerCancelOperation(id).catch(() => {}); }); };
  }, [entries]);
  const first = entries[0];
  return <ExplorerDialog onClose={onClose} testId="explorer-properties-dialog">
    <h3 id="explorer-properties-dialog-title">{label("属性", "Properties")} · {entries.length > 1 ? label(`${entries.length} 项`, `${entries.length} items`) : first.name}</h3>
    <dl style={{ display: "grid", gridTemplateColumns: "auto 1fr", gap: "5px 12px", fontSize: 12.5, overflowWrap: "anywhere" }}>
      <dt>{label("位置", "Location")}</dt><dd>{first.path}</dd>
      <dt>{label("类型", "Type")}</dt><dd>{entries.length > 1 ? label("多种类型", "Multiple types") : first.fileType}</dd>
      <dt>{label("大小", "Size")}</dt><dd data-testid="explorer-properties-size">{properties.length ? formatBytes(properties.reduce((sum, item) => sum + item.size, 0)) : label("正在计算…", "Calculating…")}{properties.some((item) => item.truncated) ? label("（已达统计上限）", " (limit reached)") : ""}</dd>
      <dt>{label("项目数", "Items")}</dt><dd>{properties.reduce((sum, item) => sum + item.itemCount, 0)}</dd>
      <dt>{label("修改日期", "Modified")}</dt><dd>{first.mtime ? new Date(first.mtime * 1000).toLocaleString() : "—"}</dd>
      <dt>{label("权限", "Permissions")}</dt><dd style={{ fontFamily: "var(--ex-mono)" }}>{formatPosixMode(first.mode, first.fileType)} {first.owner}:{first.group}</dd>
      {properties[0]?.createdAt != null && <><dt>{label("创建日期", "Created")}</dt><dd>{new Date(properties[0].createdAt * 1000).toLocaleString()}</dd></>}
      {first.symlinkTarget && <><dt>{label("链接目标", "Link target")}</dt><dd>{first.symlinkTarget}</dd></>}
    </dl>
    {error && <p role="alert" style={{ whiteSpace: "pre-wrap", color: "#ef4444", marginTop: 10 }}>{error}</p>}
    <div className="ex-dialog-footer"><button type="button" data-testid="explorer-properties-close" onClick={onClose}>{label("关闭", "Close")}</button></div>
  </ExplorerDialog>;
}
export function ExplorerDialogs({ operations }: { operations: ExplorerOperations }) {
  const label = useExplorerLabels();
  const prompt = operations.deletePrompt;
  return <>
    {operations.newFile && <ExplorerNewFileDialog operations={operations} />}
    {prompt && <ExplorerDialog testId="explorer-delete-dialog" onClose={() => operations.setDeletePrompt(null)}
      focusTestId={prompt.reason || prompt.defaultIntent === "permanent" ? "explorer-delete-cancel" : "explorer-delete-trash"}>
      <h3 id="explorer-delete-dialog-title">{prompt.reason ? label("永久删除", "Permanently delete") : label("删除", "Delete")} {prompt.entries.length === 1 ? `“${prompt.entries[0].name}”` : label(`${prompt.entries.length} 项`, `${prompt.entries.length} items`)}?</h3>
      {prompt.reason ? <>
        <p data-testid="explorer-trash-unavailable" role="alert" style={{ whiteSpace: "pre-wrap" }}>{label("回收站不可用，仅可在确认后永久删除：", "Trash unavailable. Permanent deletion requires confirmation:")}<br />{prompt.reason}</p>
        <p>{label("此操作绕过回收站，将永久删除所选项目和文件夹内的内容，无法撤销。", "This bypasses Trash and permanently deletes selected items and folder contents. This cannot be undone.")}</p>
      </> : <>
        <p>{label("请选择删除方式：移到回收站可稍后恢复；永久删除会绕过回收站且无法撤销。",
          "Choose how to delete: move the items to Trash to restore later, or delete them permanently. Permanent deletion bypasses Trash and cannot be undone.")}</p>
        <p>{label("移到回收站后可在提示中撤销，也可在系统回收站中恢复。", "Moved items can be undone from the prompt or restored from the system Trash.")}</p>
      </>}
      <p style={{ fontFamily: "var(--ex-mono)", fontSize: 11, overflowWrap: "anywhere" }}>{prompt.entries.slice(0, 3).map((entry) => <span key={entry.path}>{entry.path}<br /></span>)}{prompt.entries.length > 3 ? "…" : ""}</p>
      <div className="ex-dialog-footer">
        <button type="button" data-testid="explorer-delete-cancel" onClick={() => operations.setDeletePrompt(null)}>{label("取消", "Cancel")}</button>
        {!prompt.reason && <button type="button" data-testid="explorer-delete-trash" className="primary" disabled={operations.busy} onClick={() => operations.trash(prompt.entries)}>{label("移到回收站", "Move to Trash")}</button>}
        <button type="button" data-testid="explorer-delete-confirm" className="danger" disabled={operations.busy} onClick={() => void operations.permanentDelete(prompt.entries)}>{label("永久删除", "Delete permanently")}</button>
      </div>
    </ExplorerDialog>}
    {operations.properties && <PropertiesDialog entries={operations.properties} onClose={() => operations.setProperties(null)} />}
    {operations.unavailablePrompt && <ExplorerDialog testId="explorer-unavailable-handler-dialog" onClose={() => operations.setUnavailablePrompt(null)}>
      <h3 id="explorer-unavailable-handler-dialog-title">{label(`无法用 ${operations.unavailablePrompt.handlerLabel} 打开`, `Cannot open with ${operations.unavailablePrompt.handlerLabel}`)}</h3>
      <p role="alert">{label(
        `${operations.unavailablePrompt.path} 的关联应用（${operations.unavailablePrompt.handlerLabel}）当前不可用（开发中），不会静默改用其他应用。`,
        `The saved association for ${operations.unavailablePrompt.path} (${operations.unavailablePrompt.handlerLabel}) is currently unavailable (in development).`,
      )}</p>
      <div className="ex-dialog-footer">
        <button type="button" data-testid="open-with-fallback-cancel" onClick={() => operations.setUnavailablePrompt(null)}>{label("取消", "Cancel")}</button>
        <button type="button" data-testid="open-with-fallback-system" className="primary" onClick={() => void operations.openWithSystemFallback(operations.unavailablePrompt!.path)}>{label("用系统默认应用打开", "Open with system default app")}</button>
      </div>
    </ExplorerDialog>}
  </>;
}
