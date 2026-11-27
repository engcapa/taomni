import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { EditorView } from "@codemirror/view";
import { FileInput } from "lucide-react";
import { selectOnePath } from "../../../lib/ipc/files";
import { isTauriRuntime } from "../../../lib/runtime";
import { useViewerLabels } from "../viewerLabels";
import { DRAWIO_MAX_BYTES, parseDrawio, type DrawioPage } from "./drawioCodec";
import { readDrawioFile } from "./drawioFile";
import { DrawioImportDialog } from "./DrawioImportDialog";

export function MarkdownDrawioImport({ view, readOnly, onError }: { view: () => EditorView | null; readOnly: boolean; onError: (message: string) => void }) {
  const label = useViewerLabels();
  const input = useRef<HTMLInputElement>(null), button = useRef<HTMLButtonElement>(null);
  const [pages, setPages] = useState<DrawioPage[] | null>(null);
  const [busy, setBusy] = useState(false);
  const restoreFocus = useRef(false);
  const focusEditor = useRef(false);
  const range = useRef<{ from: number; to: number; content: string } | null>(null);
  const generation = useRef(0);
  useEffect(() => () => { generation.current++; }, []);
  useEffect(() => { if (!busy && restoreFocus.current) { restoreFocus.current = false; button.current?.focus(); } }, [busy]);
  useEffect(() => { if (!pages && focusEditor.current) { focusEditor.current = false; view()?.focus(); } }, [pages, view]);
  const close = () => { setPages(null); range.current = null; };
  return <>
    <button ref={button} type="button" className="fv-icon-button" data-testid="markdown-import-drawio" aria-label={label("导入 draw.io", "Import draw.io")} title={label("导入 draw.io", "Import draw.io")} disabled={readOnly || busy} onMouseDown={(event) => event.preventDefault()} onClick={() => {
      const editor = view(); if (!editor || editor.state.readOnly) return;
      const { from, to } = editor.state.selection.main;
      range.current = { from, to, content: editor.state.doc.toString() };
      const token = ++generation.current;
      if (!isTauriRuntime()) { input.current?.click(); return; }
      setBusy(true);
      void (async () => {
        const path = await selectOnePath({ title: "Select file to open", directory: false, filters: [{ name: "draw.io", extensions: ["drawio", "xml"] }] });
        if (token !== generation.current) return;
        if (!path) { range.current = null; restoreFocus.current = true; return; }
        const xml = await readDrawioFile(path, () => token === generation.current);
        if (xml !== null && token === generation.current) setPages(parseDrawio(xml));
      })().catch((cause: unknown) => { if (token === generation.current) onError(String(cause)); })
        .finally(() => { if (token === generation.current) setBusy(false); });
    }}><FileInput /></button>
    <input ref={input} type="file" accept=".drawio,.xml,application/xml,text/xml" hidden data-testid="markdown-drawio-input" onChange={(event) => {
      const file = event.target.files?.[0]; event.target.value = "";
      if (!file || !range.current) return;
      const token = generation.current;
      if (file.size > DRAWIO_MAX_BYTES) { onError(label("draw.io 文件超过 20 MB 限制", "draw.io file exceeds the 20 MB limit")); return; }
      void file.text().then((xml) => { const parsed = parseDrawio(xml); if (token === generation.current) setPages(parsed); })
        .catch((cause: unknown) => { if (token === generation.current) onError(String(cause)); });
    }} />
    {pages && createPortal(<div className="fv" style={{ display: "contents" }}><DrawioImportDialog pages={pages} returnFocus={button.current} onCancel={close} onInsert={(markdown) => {
      const editor = view(), selection = range.current;
      if (!editor || editor.state.readOnly || !selection || editor.state.doc.toString() !== selection.content) {
        onError(label("文档已更改，请重新选择导入位置", "Document changed; choose an import position again")); close(); return;
      }
      editor.dispatch({ changes: { from: selection.from, to: selection.to, insert: `\n\n${markdown}\n` }, selection: { anchor: selection.from + markdown.length + 3 } });
      focusEditor.current = true;
      setPages(null); range.current = null;
    }} /></div>, document.body)}
  </>;
}
