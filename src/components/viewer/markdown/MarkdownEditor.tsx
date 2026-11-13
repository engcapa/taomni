import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { EditorView, type ViewUpdate } from "@codemirror/view";
import { ListTree } from "lucide-react";
import type { ViewerDocument } from "../../../lib/viewer";
import { useDocumentStore } from "../../../stores/documentStore";
import { useFileOpenPreferences } from "../../../lib/openFile/preferences";
import { markdownDirectory, resolveMarkdownAsset } from "../../../lib/markdownAssets";
import { openExternalUrl } from "../../../lib/sftp";
import { openExplorer } from "../../../lib/explorer/openExplorer";
import { EditorSurface } from "../EditorSurface";
import { useViewerLabels } from "../viewerLabels";
import { liveMarkdown } from "./liveMarkdown";
import { markdownInput, insertMarkdownImages } from "./markdownInput";
import { formatMarkdown, markdownShortcuts, setMarkdownHeading, type MarkdownFormat } from "./markdownCommands";
import { MarkdownInsertMenu, MarkdownToolbar, type MarkdownMode } from "./MarkdownToolbar";
import { MarkdownExportMenu } from "./MarkdownExportMenu";
import { markdownHeadings } from "./markdownModel";
import { enhanceMarkdown, markdownFragment } from "./markdownRender";
import type { MarkdownWidgetContext } from "./markdownWidgetContext";
import "./markdown.css";

export function MarkdownEditor({ document: current, onError }: { document: ViewerDocument; onError: (message: string) => void }) {
  const label = useViewerLabels();
  const [mode, setMode] = useState<MarkdownMode>("live");
  const [focus, setFocus] = useState(false);
  const [outline, setOutline] = useState(true);
  const [position, setPosition] = useState(0);
  const [heading, setHeading] = useState(0);
  const [pasteStatus, setPasteStatus] = useState("");
  const [slash, setSlash] = useState<number | null>(null);
  const [printRequest, setPrintRequest] = useState(0);
  const editor = useRef<EditorView | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const imageInput = useRef<HTMLInputElement>(null);
  const imageRange = useRef<{ from: number; to: number; raw: string } | null>(null);
  const currentRef = useRef(current);
  const errorRef = useRef(onError);
  currentRef.current = current; errorRef.current = onError;
  const report = useCallback((message: string) => errorRef.current(message), []);
  const headings = useMemo(() => markdownHeadings(current.content), [current.content]);
  const activeHeading = headings.filter((item) => item.from <= position).at(-1)?.from;
  const chooseImage = useCallback((from?: number, to?: number) => {
    const view = editor.current;
    if (!view || view.state.readOnly) return;
    const start = from ?? view.state.selection.main.from, end = to ?? view.state.selection.main.to;
    imageRange.current = { from: start, to: end, raw: view.state.doc.sliceString(start, end) };
    imageInput.current?.click();
  }, []);
  const context = useMemo<MarkdownWidgetContext>(() => ({ docPath: current.path, readOnly: current.readOnly, label,
    onError: report, replaceImage: (from, to) => chooseImage(from, to), revealImage: (reference) => {
      try {
        const path = resolveMarkdownAsset(current.path, reference);
        if (!path) throw new Error(label("只能显示本地图片", "Only local images can be revealed"));
        void openExplorer(markdownDirectory(path)).catch((error: unknown) => report(String(error)));
      } catch (error) { report(String(error)); }
    },
  }), [current.path, current.readOnly, label, report, chooseImage]);
  const input = useMemo(() => markdownInput({ docPath: current.path, preferences: () => useFileOpenPreferences.getState(),
    onStatus: setPasteStatus, onError: report, label }), [current.path, label, report]);
  const shortcuts = useMemo(() => markdownShortcuts(() => {
    void useDocumentStore.getState().save(currentRef.current.path).catch((error: unknown) => report(String(error)));
  }, () => setPrintRequest((value) => value + 1)), [report]);
  const listener = useMemo(() => EditorView.updateListener.of((update: ViewUpdate) => {
    if (!update.selectionSet && !update.docChanged) return;
    const head = update.state.selection.main.head;
    const line = update.state.doc.lineAt(head);
    setPosition(head);
    setHeading(/^#{1,6}\s/.exec(line.text)?.[0].trim().length || 0);
    setSlash(!update.state.readOnly && line.text === "/" && head === line.to ? line.from : null);
  }), []);
  const extensions = useMemo(() => [input, shortcuts, listener, ...(mode === "live" ? [liveMarkdown(context, focus)] : [])],
    [input, shortcuts, listener, mode, context, focus]);
  const onView = useCallback((view: EditorView | null) => { editor.current = view; }, []);
  useEffect(() => {
    setPasteStatus(""); setSlash(null); imageRange.current = null; setPosition(0);
  }, [current.key]);
  const insert = (from: number, action: MarkdownFormat | "heading" | "image") => {
    const view = editor.current;
    if (!view || view.state.readOnly || view.state.doc.sliceString(from, from + 1) !== "/") return;
    view.dispatch({ changes: { from, to: from + 1, insert: "" }, selection: { anchor: from } });
    setSlash(null);
    if (action === "heading") setMarkdownHeading(view, 2);
    else if (action === "image") chooseImage();
    else formatMarkdown(view, action);
  };
  return <div ref={root} className={`fv-markdown ${focus ? "fv-md-focus" : ""}`} data-testid="markdown-editor" data-mode={mode}>
    <div className="fv-bar fv-md-toolbar">
      <MarkdownToolbar view={() => editor.current} readOnly={current.readOnly} mode={mode} focus={focus} outline={outline} heading={heading}
        onMode={(next) => { setSlash(null); setMode(next); }} onFocus={() => setFocus(!focus)} onOutline={() => setOutline(!outline)} onImage={chooseImage} />
      <MarkdownExportMenu document={current} onError={report} printRequest={printRequest} />
    </div>
    <div className="fv-md-wrap">
      {outline && <aside className="fv-md-outline" data-testid="markdown-outline" aria-label={label("大纲", "Outline")}>
        <div className="fv-md-outline-title"><ListTree />{label("大纲", "Outline")}</div>
        {!headings.length && <p className="fv-md-empty-outline">{label("暂无标题", "No headings")}</p>}
        {headings.map((item) => <button key={item.from} className={activeHeading === item.from ? "on" : ""} data-heading-from={item.from} style={{ paddingLeft: `${8 + (item.level - 1) * 12}px` }} title={item.text} aria-current={activeHeading === item.from ? "location" : undefined} onClick={() => {
          const view = editor.current;
          if (!view) return;
          view.dispatch({ selection: { anchor: item.from }, effects: EditorView.scrollIntoView(item.from, { y: "start" }) });
          view.focus();
          const index = headings.indexOf(item);
          root.current?.querySelector("[data-testid='markdown-preview']")?.querySelectorAll("h1,h2,h3,h4,h5,h6")[index]?.scrollIntoView({ block: "start" });
        }}>{item.text}</button>)}
      </aside>}
      <div className={`fv-md-main ${mode === "split" ? "fv-md-split" : ""}`} data-testid={`markdown-${mode}`}>
        <div className={`fv-md-editor-pane ${mode === "live" ? "fv-md-live-pane" : "fv-md-source-pane"}`}>
          <EditorSurface document={current} extensions={extensions} onView={onView} className={mode === "live" ? "fv-md-live-surface" : "fv-md-source-surface"} />
          {slash !== null && <MarkdownInsertMenu from={slash} onInsert={insert} />}
        </div>
        {mode === "split" && <MarkdownPreviewPane content={current.content} path={current.path} onError={report} />}
      </div>
    </div>
    {pasteStatus && <div className="fv-md-paste-status" role="status" data-testid="markdown-paste-status">{pasteStatus}<button aria-label={label("关闭提示", "Dismiss")} onClick={() => setPasteStatus("")}>×</button></div>}
    <input ref={imageInput} type="file" accept="image/*" hidden data-testid="markdown-image-input" multiple onChange={(event) => {
      const files = Array.from(event.target.files || []);
      event.target.value = "";
      const view = editor.current, range = imageRange.current;
      imageRange.current = null;
      if (!view || view.state.readOnly || !files.length) return;
      if (range && view.state.doc.sliceString(range.from, range.to) !== range.raw) {
        report(label("文档已更改，请重新选择插入位置", "Document changed; choose an insertion point again")); return;
      }
      void insertMarkdownImages(view, files, range || undefined);
    }} />
  </div>;
}

function MarkdownPreviewPane({ content, path, onError }: { content: string; path: string; onError: (message: string) => void }) {
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const container = root.current;
    if (!container) return;
    let cancelled = false;
    const rendered = markdownFragment(content);
    const enhancements = enhanceMarkdown(rendered, { docPath: path, cancelled: () => cancelled });
    container.replaceChildren(...Array.from(rendered.childNodes));
    void enhancements.catch((error: unknown) => { if (!cancelled) onError(String(error)); });
    return () => { cancelled = true; };
  }, [content, path, onError]);
  return <div className="fv-md-preview-pane" data-testid="markdown-preview" onClick={(event) => {
    const anchor = (event.target as Element).closest("a");
    if (!anchor) return;
    event.preventDefault();
    const href = anchor.getAttribute("href") || "";
    if (/^(https?:|mailto:)/i.test(href)) void openExternalUrl(href).catch((error: unknown) => onError(String(error)));
  }}><div ref={root} className="fv-md-doc" /></div>;
}
