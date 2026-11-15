import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { MergeView } from "@codemirror/merge";
import { EditorState } from "@codemirror/state";
import { EditorView, lineNumbers } from "@codemirror/view";
import { useDocumentStore } from "../../stores/documentStore";
import { documentPathKey } from "../../lib/openFile/pathIdentity";
import { useViewerLabels } from "./viewerLabels";
import "./viewer.css";
import { useFocusReturn } from "../editor/workspace/useFocusReturn";

export function ViewerCloseDialog() {
  const label = useViewerLabels();
  const request = useDocumentStore((state) => state.closeRequest);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const dialog = useRef<HTMLDivElement>(null);
  useFocusReturn(!!request);
  const cancel = () => { useDocumentStore.setState({ closeRequest: undefined }); request?.cancel?.(); };
  useEffect(() => {
    if (!request) return;
    setError(null);
    const listener = (event: KeyboardEvent) => {
      if (event.isComposing) return;
      if (event.key === "Escape" && !busy) { event.preventDefault(); event.stopPropagation(); cancel(); }
      if (event.key !== "Tab") return;
      const buttons = Array.from(dialog.current?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") ?? []);
      if (!buttons.length) return;
      const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
      event.preventDefault();
      buttons[(index + (event.shiftKey ? -1 : 1) + buttons.length) % buttons.length].focus();
    };
    window.addEventListener("keydown", listener);
    return () => window.removeEventListener("keydown", listener);
  }, [request, busy]);
  if (!request) return null;
  const finish = () => { useDocumentStore.setState({ closeRequest: undefined }); request.proceed(); };
  return createPortal(<div className="fv fv-global-dialog"><div className="fv-modal-bg"><div ref={dialog} className="fv-modal" role="dialog" aria-modal="true" aria-label={label("保存更改", "Save changes")} data-testid="viewer-close-dialog">
    <h3>{label("保存未保存的更改？", "Save unsaved changes?")}</h3>
    <p>{request.paths.map((path) => <span style={{ display: "block" }} key={path}>{path}</span>)}</p>
    {request.paths.some((path) => useDocumentStore.getState().documents[documentPathKey(path)]?.external) && <p>{label("磁盘版本已更改。取消关闭后可在文件横幅比较差异、重新加载或保留我的版本。", "The disk version changed. Cancel closing to compare, reload or keep your version in the file banner.")}</p>}
    {error && <p role="alert">{error}</p>}
    <footer><button className="fv-button outline" data-testid="viewer-close-cancel" disabled={busy} onClick={cancel}>{label("取消", "Cancel")}</button><button className="fv-button" data-testid="viewer-close-discard" disabled={busy} onClick={() => { request.paths.forEach((path) => useDocumentStore.getState().discard(path)); finish(); }}>{label("不保存", "Discard")}</button><button autoFocus className="fv-button primary" data-testid="viewer-close-save" disabled={busy} onClick={() => { setBusy(true); setError(null); void (async () => { try { for (const path of request.paths) await useDocumentStore.getState().save(path); finish(); } catch (failure) { setError(String(failure)); } finally { setBusy(false); } })(); }}>{label("保存", "Save")}</button></footer>
  </div></div></div>, document.body);
}

export function ViewerDiff({ disk, mine, onClose }: { disk: string; mine: string; onClose: () => void }) {
  const label = useViewerLabels();
  const host = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!host.current) return;
    const extensions = [lineNumbers(), EditorState.readOnly.of(true), EditorView.editable.of(false), EditorView.theme({ "&": { height: "100%", color: "var(--text)", background: "var(--bg)" }, ".cm-scroller": { overflow: "auto", fontSize: "12px" } })];
    const view = new MergeView({ parent: host.current, a: { doc: disk, extensions }, b: { doc: mine, extensions }, highlightChanges: true, gutter: true });
    return () => view.destroy();
  }, [disk, mine]);
  return <div className="fv-modal-bg"><div className="fv-modal" role="dialog" aria-modal="true" data-testid="viewer-diff" style={{ width: "90%", height: "80%", display: "flex", flexDirection: "column" }}><h3>{label("磁盘版本 ← → 我的版本", "Disk version ← → My version")}</h3><div ref={host} className="fv-diff" /><footer><button autoFocus className="fv-button outline" onClick={onClose}>{label("关闭", "Close")}</button></footer></div></div>;
}
