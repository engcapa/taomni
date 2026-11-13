import { lazy, Suspense, useEffect, useState } from "react";
import { getAppPlatform } from "../../lib/runtime";
import { AlertCircle, FolderOpen, RefreshCw, Save, Shield } from "lucide-react";
import { useDocumentStore } from "../../stores/documentStore";
import { documentPathKey } from "../../lib/openFile/pathIdentity";
import { sftpOpenPath, parentPath } from "../../lib/sftp";
import { openExplorer } from "../../lib/explorer/openExplorer";
import { useViewerLabels } from "./viewerLabels";
import { TextEditor } from "./TextEditor";
import { ViewerDiff } from "./ViewerDialogs";
import type { FileViewerTabInfo } from "../../types";
import "./viewer.css";

const ImageViewer = lazy(() => import("./ImageViewer").then((module) => ({ default: module.ImageViewer })));
const HtmlPreview = lazy(() => import("./HtmlPreview").then((module) => ({ default: module.HtmlPreview })));
const MarkdownEditor = lazy(() => import("./markdown/MarkdownEditor").then((module) => ({ default: module.MarkdownEditor })));
const hosts = new Map<string, number>();

export function ViewerShell({ viewer, active = true, workspaceId }: { viewer: FileViewerTabInfo; active?: boolean; workspaceId?: string }) {
  const label = useViewerLabels();
  const key = documentPathKey(viewer.path);
  const document = useDocumentStore((state) => state.documents[key]);
  const draftError = useDocumentStore((state) => state.draftError);
  const [error, setError] = useState<string | null>(null);
  const [compare, setCompare] = useState(false);
  useEffect(() => {
    hosts.set(key, (hosts.get(key) ?? 0) + 1);
    void useDocumentStore.getState().open(viewer.path, viewer.readOnlyReason);
    return () => {
      hosts.set(key, Math.max(0, (hosts.get(key) ?? 1) - 1));
      queueMicrotask(() => { if (hosts.get(key) === 0) { hosts.delete(key); useDocumentStore.getState().release(viewer.path); } });
    };
  }, [key, viewer.path, viewer.readOnlyReason]);
  useEffect(() => {
    if (!active) return;
    const refresh = () => { void useDocumentStore.getState().checkExternal(viewer.path); };
    refresh();
    window.addEventListener("focus", refresh);
    const visible = () => { if (globalThis.document.visibilityState === "visible") refresh(); };
    globalThis.document.addEventListener("visibilitychange", visible);
    return () => { window.removeEventListener("focus", refresh); globalThis.document.removeEventListener("visibilitychange", visible); };
  }, [active, viewer.path]);
  const run = (action: () => Promise<unknown>) => { setError(null); void action().catch((failure) => setError(String(failure))); };
  const toLocal = async () => {
    const { selectSaveFilePath, writeStreamAbort, writeStreamAppend, writeStreamClose, writeStreamOpen } = await import("../../lib/ipc/files");
    const { viewerReadBytes } = await import("../../lib/viewer");
    const { openFile } = await import("../../lib/openFile");
    const path = await selectSaveFilePath(viewer.path.split(/[\\/]/).pop());
    if (!path) return;
    const { explorerCanonicalPath } = await import("../../lib/explorer");
    let targetKey = documentPathKey(path);
    try { targetKey = documentPathKey(await explorerCanonicalPath(path)); } catch { /* A new destination has no canonical path yet. */ }
    if (targetKey === key) throw new Error(label("另存位置必须不同于只读副本", "Save to a different path from the read-only copy"));
    const bytes = await viewerReadBytes(viewer.path);
    const handle = await writeStreamOpen(path);
    try { await writeStreamAppend(handle, new Uint8Array(bytes.bytes)); await writeStreamClose(handle); }
    catch (failure) { await writeStreamAbort(handle).catch(() => {}); throw failure; }
    await openFile({ path }, { context: "viewer-save-as", workspaceId });
  };
  const showError = !document || !!document.error && !document.savedHash && !document.content;
  return <section className="fv" data-testid="file-viewer" data-path={viewer.path} data-kind={viewer.kind} data-dirty={document?.dirty || undefined} data-readonly={document?.readOnly || undefined} onKeyDown={(event) => {
      if (event.defaultPrevented || event.nativeEvent.isComposing || !active || event.altKey || event.shiftKey) return;
      const mod = getAppPlatform() === "macos" ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
      if (mod && event.key.toLowerCase() === "s") {
        event.preventDefault(); event.stopPropagation();
        if (document && !document.readOnly) run(() => useDocumentStore.getState().save(viewer.path));
      }
    }}>
    {document?.readOnlyReason && <div className="fv-banner info" data-testid="viewer-readonly"><Shield /><span>{label("只读副本", "Read-only copy")} — {document.readOnlyReason}</span><span className="fv-spacer" /><button className="fv-button outline" data-testid="viewer-save-as" onClick={() => run(toLocal)}>{label("另存为本地后编辑", "Save locally to edit")}</button></div>}
    {document?.restored && <div className="fv-banner info" data-testid="viewer-draft-restored">{label("已恢复未保存草稿；磁盘文件未被改动。", "Recovered unsaved draft; the disk file has not been modified.")}</div>}
    {document?.external && <div className="fv-banner warn" data-testid="viewer-conflict"><AlertCircle /><span>{label("文件已被其他程序修改。", "This file was modified by another program.")}</span><button className="fv-button outline" data-testid="viewer-reload" onClick={() => run(() => useDocumentStore.getState().reload(viewer.path))}>{label("重新加载", "Reload")}</button><button className="fv-button outline" data-testid="viewer-compare" onClick={() => setCompare(true)}>{label("比较差异", "Compare changes")}</button><button className="fv-button" data-testid="viewer-keep" onClick={() => useDocumentStore.getState().keepMine(viewer.path)}>{label("保留我的版本", "Keep my version")}</button></div>}
    {(error || draftError || document?.error && !showError) && <div className="fv-banner warn" role="alert" data-testid="viewer-operation-error">{error || draftError || document?.error}<button className="fv-button" onClick={() => setError(null)}>×</button></div>}
    {!document || document.loading && !document.content ? <div className="fv-loading" role="status">{label("正在打开文件…", "Opening file…")}</div>
      : showError ? <div className="fv-error" data-testid="viewer-error"><AlertCircle /><h3>{label("无法打开文件", "Unable to open file")}</h3><p>{document.error}</p><div><button className="fv-button outline" data-testid="viewer-retry" onClick={() => run(() => useDocumentStore.getState().open(viewer.path, viewer.readOnlyReason))}><RefreshCw />{label("重试", "Retry")}</button><button className="fv-button" data-testid="viewer-system" onClick={() => run(() => sftpOpenPath(viewer.path))}>{label("系统应用", "System app")}</button><button className="fv-button" onClick={() => run(() => openExplorer(parentPath(viewer.path), { workspaceId }))}><FolderOpen />{label("在 Explorer 中显示", "Show in Explorer")}</button></div></div>
      : <Suspense fallback={<div className="fv-loading">{label("正在加载查看器…", "Loading viewer…")}</div>}>
        {viewer.mode === "source" || document.large ? <TextEditor document={document} onError={setError} workspaceId={workspaceId} />
          : viewer.kind === "image" || viewer.kind === "svg" ? <ImageViewer document={document} onError={setError} workspaceId={workspaceId} />
            : viewer.kind === "markdown" ? <MarkdownEditor document={document} onError={setError} />
              : viewer.kind === "html" ? <HtmlPreview document={document} onError={setError} visible={active} workspaceId={workspaceId} /> : <TextEditor document={document} onError={setError} workspaceId={workspaceId} />}
      </Suspense>}
    {document && !document.loading && !showError && <div className="fv-status" data-testid="viewer-status"><span className={document.dirty ? "dirty" : ""}>{document.dirty ? label("● 未保存", "● Unsaved") : label("已保存", "Saved")}</span>{document.dirty && viewer.kind !== "text" && viewer.mode !== "source" && !document.large && <button className="fv-button" data-testid="viewer-save" disabled={document.readOnly || document.saving} onClick={() => run(() => useDocumentStore.getState().save(viewer.path))}><Save />{label("保存", "Save")}</button>}<span>{document.content.length.toLocaleString()} {label("字符", "characters")}</span><span className="fv-spacer" /><span>{document.encoding} · {document.eol}</span><span>{viewer.kind}</span></div>}
    {compare && document?.external && <ViewerDiff disk={document.external.content} mine={document.content} onClose={() => setCompare(false)} />}
  </section>;
}
