import { useEffect, useId, useRef, useState } from "react";
import { Modal } from "../ui/Modal";
import { ModalSurface } from "../ui/ModalSurface";
import { Button } from "../ui/Button";
import { MergeView } from "@codemirror/merge";
import { EditorState } from "@codemirror/state";
import { EditorView, lineNumbers } from "@codemirror/view";
import { useDocumentStore, type ViewerCloseRequest } from "../../stores/documentStore";
import { discardViewerChanges, saveViewerChanges } from "../../lib/openFile/closeGuard";
import { documentPathKey } from "../../lib/openFile/pathIdentity";
import { useViewerLabels } from "./viewerLabels";
import "./viewer.css";

export function ViewerCloseDialog() {
  const request = useDocumentStore((state) => state.closeRequest);
  return request ? <CloseDecision request={request} /> : null;
}

function CloseDecision({ request }: { request: ViewerCloseRequest }) {
  const label = useViewerLabels();
  const savesCopy = useDocumentStore((state) => request.paths.some((path) => state.moduleDrafts[documentPathKey(path)]));
  const [pending, setPending] = useState<"draft" | "save" | null>(null);
  const running = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const cancel = () => {
    if (running.current) return;
    useDocumentStore.setState({ closeRequest: undefined });
    request.cancel?.();
  };
  const finish = () => {
    if (useDocumentStore.getState().closeRequest !== request) return;
    useDocumentStore.setState({ closeRequest: undefined });
    request.proceed();
  };
  async function persist(action: "draft" | "save") {
    if (running.current) return;
    running.current = true;
    setPending(action);
    setError(null);
    try {
      const store = useDocumentStore.getState();
      if (action === "draft") {
        await store.persistRecoveryDrafts(request.paths);
      } else {
        for (const path of request.paths) {
          if (!(await saveViewerChanges(path))) return;
        }
      }
      finish();
    } catch (failure) {
      const detail = String(failure);
      setError(action === "draft" ? label(
        `草稿保存失败：${detail}。文件未关闭，请重试，或取消后手动保存文件。`,
        `Draft could not be saved: ${detail}. The file remains open. Retry, or cancel and save the file manually.`,
      ) : detail);
    } finally {
      running.current = false;
      setPending(null);
    }
  }
  useEffect(() => setError(null), [request]);
  const external = request.paths.some((path) => useDocumentStore.getState().documents[documentPathKey(path)]?.external);
  return <Modal title={label("保存未保存的更改？", "Save unsaved changes?")} testId="viewer-close-dialog"
    initialFocus='[data-testid="viewer-close-cancel"]' onCancel={cancel}
    footer={<>
      <Button variant="danger" data-testid="viewer-close-discard" disabled={!!pending} onClick={() => {
        if (running.current) return;
        request.paths.forEach(discardViewerChanges);
        finish();
      }}>{label("放弃更改", "Discard changes")}</Button>
      {!savesCopy && <Button data-testid="viewer-close-keep-draft" disabled={!!pending} busy={pending === "draft"}
        onClick={() => void persist("draft")}>{label("保留草稿", "Keep draft")}</Button>}
      <Button data-testid="viewer-close-cancel" disabled={!!pending} onClick={cancel}>{label("取消", "Cancel")}</Button>
      <Button variant="primary" data-testid="viewer-close-save" disabled={!!pending} busy={pending === "save"}
        onClick={() => void persist("save")}>{savesCopy ? label("保存更改…", "Save changes…") : label("保存", "Save")}</Button>
    </>}>
    <p>{request.paths.map((path) => <span className="block" key={path}>{path}</span>)}</p>
    {external && <p>{label("磁盘版本已更改。取消关闭后可在文件横幅比较差异、重新加载或保留我的版本。",
      "The disk version changed. Cancel closing to compare, reload or keep your version in the file banner.")}</p>}
    {error && <p className="text-ui-danger" role="alert" data-testid="viewer-close-error">{error}</p>}
  </Modal>;
}

export function ViewerDiff({ disk, mine, onClose }: { disk: string; mine: string; onClose: () => void }) {
  const label = useViewerLabels();
  const host = useRef<HTMLDivElement>(null);
  const titleId = useId();
  useEffect(() => {
    if (!host.current) return;
    const extensions = [lineNumbers(), EditorState.readOnly.of(true), EditorView.editable.of(false), EditorView.theme({ "&": { height: "100%", color: "var(--text)", background: "var(--bg)" }, ".cm-scroller": { overflow: "auto", fontSize: "var(--taomni-fs-body)" } })];
    const view = new MergeView({ parent: host.current, a: { doc: disk, extensions }, b: { doc: mine, extensions }, highlightChanges: true, gutter: true });
    return () => view.destroy();
  }, [disk, mine]);
  return <ModalSurface className="taomni-modal fv-diff-dialog" data-testid="viewer-diff" aria-labelledby={titleId}
    initialFocus="footer button" onCancel={onClose}>
    <h2 id={titleId}>{label("磁盘版本 ← → 我的版本", "Disk version ← → My version")}</h2>
    <div ref={host} className="fv-diff" />
    <footer className="taomni-modal-footer"><Button onClick={onClose}>{label("关闭", "Close")}</Button></footer>
  </ModalSurface>;
}
