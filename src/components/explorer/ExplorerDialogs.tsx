import { useEffect, useRef, useState } from "react";
import { explorerCancelOperation, localProperties, type LocalProperties } from "../../lib/explorer";
import { formatBytes, formatPosixMode, type FileEntry } from "../../lib/sftp";
import { useFocusReturn } from "../editor/workspace/useFocusReturn";
import { useExplorerLabels } from "./explorerLabels";
import type { ExplorerOperations } from "./useExplorerOperations";

function ExplorerDialog({ children, onClose, testId }: { children: React.ReactNode; onClose: () => void; testId: string }) {
  useFocusReturn(true);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const first = ref.current?.querySelector<HTMLButtonElement>("button");
    first?.focus();
  }, []);
  return <div className="ex-dialog-back" onPointerDown={(event) => event.stopPropagation()}>
    <div ref={ref} className="ex-dialog" data-testid={testId} role="dialog" aria-modal="true" tabIndex={-1} onKeyDown={(event) => {
      event.stopPropagation();
      if (event.key === "Escape") { event.preventDefault(); onClose(); }
      if (event.key === "Tab") {
        const buttons = Array.from(ref.current?.querySelectorAll<HTMLElement>("button,input,[tabindex='0']") ?? []);
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
    <h3>{label("属性", "Properties")} · {entries.length > 1 ? label(`${entries.length} 项`, `${entries.length} items`) : first.name}</h3>
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
    <div className="ex-dialog-footer"><button data-testid="explorer-properties-close" onClick={onClose}>{label("关闭", "Close")}</button></div>
  </ExplorerDialog>;
}
export function ExplorerDialogs({ operations }: { operations: ExplorerOperations }) {
  const label = useExplorerLabels();
  const prompt = operations.deletePrompt;
  return <>
    {prompt && <ExplorerDialog testId="explorer-delete-dialog" onClose={() => operations.setDeletePrompt(null)}>
      <h3>{label("永久删除", "Permanently delete")} {prompt.entries.length === 1 ? `“${prompt.entries[0].name}”` : label(`${prompt.entries.length} 项`, `${prompt.entries.length} items`)}?</h3>
      {prompt.reason && <p data-testid="explorer-trash-unavailable" role="alert" style={{ whiteSpace: "pre-wrap" }}>{label("回收站不可用，仅可在确认后永久删除：", "Trash unavailable. Permanent deletion requires confirmation:")}<br />{prompt.reason}</p>}
      <p>{label("此操作绕过回收站，将永久删除所选项目和文件夹内的内容，无法撤销。", "This bypasses Trash and permanently deletes selected items and folder contents. This cannot be undone.")}</p>
      <p style={{ fontFamily: "var(--ex-mono)", fontSize: 11, overflowWrap: "anywhere" }}>{prompt.entries.slice(0, 3).map((entry) => <span key={entry.path}>{entry.path}<br /></span>)}{prompt.entries.length > 3 ? "…" : ""}</p>
      <div className="ex-dialog-footer">
        <button data-testid="explorer-delete-cancel" onClick={() => operations.setDeletePrompt(null)}>{label("取消", "Cancel")}</button>
        <button data-testid="explorer-delete-confirm" className="danger" onClick={() => void operations.permanentDelete(prompt.entries)}>{label("永久删除", "Delete permanently")}</button>
      </div>
    </ExplorerDialog>}
    {operations.properties && <PropertiesDialog entries={operations.properties} onClose={() => operations.setProperties(null)} />}
  </>;
}
