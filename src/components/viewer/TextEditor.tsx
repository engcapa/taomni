import { useRef, useState } from "react";
import { Redo2, Save, Search, Undo2, WrapText } from "lucide-react";
import { EditorView } from "@codemirror/view";
import { redo, undo } from "@codemirror/commands";
import { openSearchPanel } from "@codemirror/search";
import { EditorSurface } from "./EditorSurface";
import { useViewerLabels } from "./viewerLabels";
import { setFileOpenPreferences, useFileOpenPreferences } from "../../lib/openFile/preferences";
import { openFile } from "../../lib/openFile";
import { useDocumentStore } from "../../stores/documentStore";
import { VIEWER_TEXT_HARD_LIMIT, type ViewerDocument, type ViewerEol } from "../../lib/viewer";

export function TextEditor({ document, onError, workspaceId, onCursorChange }: { document: ViewerDocument; onError: (message: string) => void; workspaceId?: string; onCursorChange?: (cursor: { line: number; column: number }) => void }) {
  const label = useViewerLabels();
  const preferences = useFileOpenPreferences();
  const editor = useRef<EditorView | null>(null);
  const [confirmEdit, setConfirmEdit] = useState(false);
  const [encoding, setEncoding] = useState<string | null>(null);
  const [offsets, setOffsets] = useState<number[]>([]);
  const run = (action: () => Promise<unknown>) => void action().catch((error) => onError(String(error)));
  return <>
    <div className="fv-bar" data-testid="viewer-text-toolbar">
      <button className={`fv-button ${document.dirty ? "primary" : ""}`} data-testid="viewer-save" disabled={document.readOnly || document.saving || !document.dirty} onClick={() => run(() => useDocumentStore.getState().save(document.path))}><Save />{label("保存", "Save")}<small>{/Mac/i.test(navigator.platform) ? "⌘S" : "Ctrl+S"}</small></button>
      <span className="fv-separator" />
      <button className="fv-icon-button" title={label("撤销", "Undo")} disabled={document.readOnly} onClick={() => { if (editor.current) undo(editor.current); }}><Undo2 /></button>
      <button className="fv-icon-button" title={label("重做", "Redo")} disabled={document.readOnly} onClick={() => { if (editor.current) redo(editor.current); }}><Redo2 /></button>
      <button className="fv-icon-button" data-testid="viewer-find" title={label("查找", "Find")} onClick={() => { if (editor.current) openSearchPanel(editor.current); }}><Search /></button>
      <span className="fv-separator" />
      <button className="fv-button" data-testid="viewer-wrap" aria-pressed={preferences.wrap} onClick={() => setFileOpenPreferences({ wrap: !preferences.wrap })}><WrapText />{label("自动换行", "Word wrap")}<span className={`fv-toggle ${preferences.wrap ? "on" : ""}`} /></button>
      <label className="fv-font-size">A⁺ <select aria-label={label("字号", "Font size")} data-testid="viewer-font-size" value={preferences.fontSize} onChange={(event) => setFileOpenPreferences({ fontSize: Number(event.target.value) })}>{[11, 12, 13, 14, 15, 16, 18, 20, 24, 28, 32].map((size) => <option key={size} value={size}>{size}px</option>)}</select></label>
      <span className="fv-spacer" />
      <select className="fv-select" data-testid="viewer-encoding" aria-label={label("编码", "Encoding")} disabled={document.readOnly} value={document.encoding} onChange={(event) => setEncoding(event.target.value)}>{[...new Set([document.encoding, "UTF-8", "UTF-16LE", "UTF-16BE", "GBK", "windows-1252"])].map((value) => <option key={value}>{value}</option>)}</select>
      <select className="fv-select" data-testid="viewer-eol" aria-label={label("换行符", "Line endings")} disabled={document.readOnly} value={document.eol} onChange={(event) => useDocumentStore.getState().configure(document.path, { eol: event.target.value as ViewerEol })}>{["LF", "CRLF", "CR", "mixed"].map((value) => <option key={value}>{value}</option>)}</select>
      <button className="fv-button" disabled={!!document.readOnlyReason} onClick={() => run(() => openFile({ path: document.path }, { context: "viewer", workspaceId, mode: "workspace" }))}>{label("在 Workspace 中编辑", "Edit in Workspace")}</button>
    </div>
    {document.large && <div className="fv-banner warn" data-testid="viewer-large-file"><span>{label("大文件：只读分块查看，不会加载完整内容到编辑器。", "Large file: viewing read-only chunks without loading the entire document.")}</span><span className="fv-spacer" /><button className="fv-button outline" data-testid="viewer-enable-edit" disabled={document.size > VIEWER_TEXT_HARD_LIMIT || !!document.readOnlyReason} onClick={() => setConfirmEdit(true)}>{label("仍以编辑方式打开", "Open for editing anyway")}</button></div>}
    <EditorSurface document={document} onView={(view) => { editor.current = view; }} onCursorChange={onCursorChange} />
    {document.large && <div className="fv-bar"><button className="fv-button" data-testid="viewer-chunk-previous" disabled={!offsets.length || document.loading} onClick={() => { const next = offsets.at(-1)!; setOffsets((old) => old.slice(0, -1)); run(() => useDocumentStore.getState().readChunk(document.path, next)); }}>{label("上一块", "Previous chunk")}</button><span>{document.chunkOffset.toLocaleString()}–{document.nextOffset.toLocaleString()} / {document.size.toLocaleString()} bytes</span><button className="fv-button" data-testid="viewer-chunk-next" disabled={document.eof || document.loading} onClick={() => { setOffsets((old) => [...old, document.chunkOffset]); run(() => useDocumentStore.getState().readChunk(document.path, document.nextOffset)); }}>{label("下一块", "Next chunk")}</button></div>}
    {confirmEdit && <div className="fv-modal-bg"><div className="fv-modal" role="dialog" aria-modal="true" data-testid="viewer-large-confirm"><h3>{label("编辑大文件", "Edit a large file")}</h3><p>{label("编辑完整文件可能占用较多内存。最大支持 20 MB，是否继续？", "Editing the whole file can use substantial memory. The maximum is 20 MB. Continue?")}</p><footer><button className="fv-button outline" onClick={() => setConfirmEdit(false)}>{label("取消", "Cancel")}</button><button className="fv-button primary" onClick={() => { setConfirmEdit(false); run(() => useDocumentStore.getState().open(document.path, undefined, true)); }}>{label("继续编辑", "Continue editing")}</button></footer></div></div>}
    {encoding && <div className="fv-modal-bg"><div className="fv-modal" role="dialog" aria-modal="true" data-testid="viewer-encoding-dialog"><h3>{label("切换编码", "Change encoding")} — {encoding}</h3><p>{label("选择转换保存编码，或使用此编码重新读取磁盘（将丢弃当前修改）。", "Convert the save encoding, or reload the disk file using this encoding (discarding current edits).")}</p><footer><button className="fv-button" onClick={() => setEncoding(null)}>{label("取消", "Cancel")}</button><button className="fv-button outline" onClick={() => { const value = encoding; setEncoding(null); run(() => useDocumentStore.getState().reload(document.path, value)); }}>{label("重新读取", "Reload")}</button><button className="fv-button primary" onClick={() => { useDocumentStore.getState().configure(document.path, { encoding }); setEncoding(null); }}>{label("转换编码", "Convert encoding")}</button></footer></div></div>}
  </>;
}
