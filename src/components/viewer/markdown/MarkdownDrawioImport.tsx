import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { EditorView } from "@codemirror/view";
import { FileInput } from "lucide-react";
import { useViewerLabels } from "../viewerLabels";
import { DRAWIO_MAX_BYTES, parseDrawio, type DrawioPage } from "./drawioCodec";
import { DrawioImportDialog } from "./DrawioImportDialog";

export function MarkdownDrawioImport({ view, readOnly, onError }: { view: () => EditorView | null; readOnly: boolean; onError: (message: string) => void }) {
  const label = useViewerLabels();
  const input = useRef<HTMLInputElement>(null), button = useRef<HTMLButtonElement>(null);
  const [pages, setPages] = useState<DrawioPage[] | null>(null);
  const range = useRef<{ from: number; to: number; content: string } | null>(null);
  const generation = useRef(0);
  useEffect(() => () => { generation.current++; }, []);
  const close = () => { setPages(null); range.current = null; button.current?.focus(); };
  return <>
    <button ref={button} type="button" className="fv-icon-button" data-testid="markdown-import-drawio" aria-label={label("导入 draw.io", "Import draw.io")} title={label("导入 draw.io", "Import draw.io")} disabled={readOnly} onMouseDown={(event) => event.preventDefault()} onClick={() => {
      const editor = view(); if (!editor || editor.state.readOnly) return;
      const { from, to } = editor.state.selection.main;
      range.current = { from, to, content: editor.state.doc.toString() }; input.current?.click();
    }}><FileInput /></button>
    <input ref={input} type="file" accept=".drawio,.xml,application/xml,text/xml" hidden data-testid="markdown-drawio-input" onChange={(event) => {
      const file = event.target.files?.[0]; event.target.value = "";
      if (!file || !range.current) return;
      const token = ++generation.current;
      if (file.size > DRAWIO_MAX_BYTES) { onError(label("draw.io 文件超过 20 MB 限制", "draw.io file exceeds the 20 MB limit")); return; }
      void file.text().then((xml) => { const parsed = parseDrawio(xml); if (token === generation.current) setPages(parsed); })
        .catch((cause: unknown) => { if (token === generation.current) onError(String(cause)); });
    }} />
    {pages && createPortal(<div className="fv" style={{ display: "contents" }}><DrawioImportDialog pages={pages} onCancel={close} onInsert={(markdown) => {
      const editor = view(), selection = range.current;
      if (!editor || editor.state.readOnly || !selection || editor.state.doc.toString() !== selection.content) {
        onError(label("文档已更改，请重新选择导入位置", "Document changed; choose an import position again")); close(); return;
      }
      editor.dispatch({ changes: { from: selection.from, to: selection.to, insert: `\n\n${markdown}\n` }, selection: { anchor: selection.from + markdown.length + 3 } });
      setPages(null); range.current = null; editor.focus();
    }} /></div>, document.body)}
  </>;
}
