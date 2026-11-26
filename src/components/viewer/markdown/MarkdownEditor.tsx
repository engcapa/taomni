import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { EditorView, type ViewUpdate } from "@codemirror/view";
import { findNext, findPrevious, getSearchQuery, openSearchPanel, searchPanelOpen, setSearchQuery } from "@codemirror/search";
import { HighlightStyle, syntaxHighlighting } from "@codemirror/language";
import { tags } from "@lezer/highlight";
import { ListTree } from "lucide-react";
import type { ViewerDocument } from "../../../lib/viewer";
import { useDocumentStore } from "../../../stores/documentStore";
import { useFileOpenPreferences } from "../../../lib/openFile/preferences";
import { markdownDirectory, resolveMarkdownAsset } from "../../../lib/markdownAssets";
import { markdownImagePolicy, readFileMarkdownImage } from "../../../lib/markdownRemoteImages";
import { openExternalUrl } from "../../../lib/sftp";
import { openExplorer } from "../../../lib/explorer/openExplorer";
import { codeHighlightStyle } from "../../../lib/codeViewTheme";
import { getAppPlatform } from "../../../lib/runtime";
import { createWorkspaceSearchPanel, openWorkspaceReplacePanel, WORKSPACE_SEARCH_STYLE } from "../../editor/workspace/editorSearchPanel";
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
import type { MarkdownDocumentOwner } from "./markdownOwner";
import { MarkdownSplit } from "./MarkdownSplit";
import { PreviewAppearanceControl, previewThemeStyle, usePreviewTheme, type PreviewAppearance } from "./PreviewAppearance";
import { MarkdownDiagramActions } from "./MarkdownDiagramActions";
import { MarkdownLiveMenu } from "./MarkdownLiveMenu";
import { MarkdownRenderWarnings } from "./MarkdownRenderWarnings";
import type { MarkdownRenderLabel, MarkdownRenderWarning } from "./markdownRenderFallback";
import { MarkdownDrawioImport } from "./MarkdownDrawioImport";
import { markdownSearchHighlights } from "./markdownSearchHighlights";
import { useMarkdownZoom } from "./useMarkdownZoom";
import "./markdown.css";

const markdownHighlighting = syntaxHighlighting(HighlightStyle.define([
  ...codeHighlightStyle.specs,
  { tag: tags.processingInstruction, class: "fv-md-syntax-marker" },
  { tag: tags.monospace, color: "var(--taomni-code-syntax-string)" },
  { tag: tags.strikethrough, textDecoration: "line-through" },
]));

export function MarkdownEditor({ document: current, onError, owner, requestedMode, onModeChange, active }: {
  document: ViewerDocument; onError: (message: string) => void; owner?: MarkdownDocumentOwner;
  requestedMode?: MarkdownMode; onModeChange?: (mode: MarkdownMode) => void;
  active?: boolean;
}) {
  const label = useViewerLabels();
  const [mode, setMode] = useState<MarkdownMode>(requestedMode ?? "live");
  const [editing, setEditing] = useState(false);
  const [appearance, setAppearance] = useState<PreviewAppearance>("auto");
  const previewTheme = usePreviewTheme(appearance);
  const imagePolicy = useFileOpenPreferences(markdownImagePolicy);
  const readImage = useMemo(() => owner?.readImage ?? ((reference: string) => {
    // Changing the policy refreshes mounted images, including cached results.
    return readFileMarkdownImage(current.path, reference);
  }), [current.path, imagePolicy, owner?.readImage]);
  const effectiveReadOnly = current.readOnly || current.truncated || (mode === "live" && !editing);
  const surfaceDocument = useMemo(() => ({ ...current, readOnly: effectiveReadOnly }), [current, effectiveReadOnly]);
  const [focus, setFocus] = useState(false);
  const [outline, setOutline] = useState(true);
  const [position, setPosition] = useState(0);
  const [heading, setHeading] = useState(0);
  const [pasteStatus, setPasteStatus] = useState("");
  const [renderWarningState, setRenderWarningState] = useState<{ warnings: MarkdownRenderWarning[]; dismissed: boolean }>({ warnings: [], dismissed: false });
  const [slash, setSlash] = useState<number | null>(null);
  const [printRequest, setPrintRequest] = useState(0);
  const editor = useRef<EditorView | null>(null);
  const root = useRef<HTMLDivElement>(null);
  const main = useRef<HTMLDivElement>(null);
  const { percent: zoom, onKeyDown: handleZoomKey } = useMarkdownZoom(main, active !== false);
  useLayoutEffect(() => { editor.current?.requestMeasure(); }, [zoom]);
  const imageInput = useRef<HTMLInputElement>(null);
  const imageRange = useRef<{ from: number; to: number; raw: string } | null>(null);
  const currentRef = useRef(current);
  const errorRef = useRef(onError);
  const ownerRef = useRef(owner);
  ownerRef.current = owner;
  currentRef.current = current; errorRef.current = onError;
  const report = useCallback((message: string) => errorRef.current(message), []);
  const onRenderWarning = useCallback((warning: MarkdownRenderWarning) => {
    setRenderWarningState((currentState) => {
      const index = currentState.warnings.findIndex((item) => item.id === warning.id);
      if (index >= 0 && currentState.warnings[index].message === warning.message) return currentState;
      const warnings = [...currentState.warnings];
      if (index >= 0) warnings[index] = warning;
      else warnings.push(warning);
      return { warnings, dismissed: false };
    });
  }, []);
  const headings = useMemo(() => markdownHeadings(current.content), [current.content]);
  const activeHeading = headings.filter((item) => item.from <= position).at(-1)?.from;
  const chooseImage = useCallback((from?: number, to?: number) => {
    const view = editor.current;
    if (!view || view.state.readOnly) return;
    const start = from ?? view.state.selection.main.from, end = to ?? view.state.selection.main.to;
    imageRange.current = { from: start, to: end, raw: view.state.doc.sliceString(start, end) };
    imageInput.current?.click();
  }, []);
  const context = useMemo<MarkdownWidgetContext>(() => ({ docPath: current.path, readOnly: effectiveReadOnly, theme: previewTheme, readImage,
    onChange: owner?.onChange ?? ((content) => useDocumentStore.getState().edit(current.path, content)), label,
    onError: report, onWarning: onRenderWarning, replaceImage: (from, to) => chooseImage(from, to), revealImage: (reference) => {
      try {
        if (owner?.revealImage) { owner.revealImage(reference); return; }
        const path = resolveMarkdownAsset(current.path, reference);
        if (!path) throw new Error(label("只能显示本地图片", "Only local images can be revealed"));
        void openExplorer(markdownDirectory(path)).catch((error: unknown) => report(String(error)));
      } catch (error) { report(String(error)); }
    },
  }), [current.path, effectiveReadOnly, previewTheme, readImage, owner?.onChange, owner?.revealImage, label, report, onRenderWarning, chooseImage]);
  const input = useMemo(() => markdownInput({ docPath: current.path, preferences: () => useFileOpenPreferences.getState(),
    onStatus: setPasteStatus, onError: report, label, saveImage: owner?.saveImage }), [current.path, label, report, owner?.saveImage]);
  const save = useCallback(() => Promise.resolve(ownerRef.current ? ownerRef.current.onSave() : useDocumentStore.getState().save(currentRef.current.path)), []);
  const shortcuts = useMemo(() => markdownShortcuts(() => {
    void save().catch((error: unknown) => report(String(error)));
  }, () => setPrintRequest((value) => value + 1)), [report, save]);
  const listener = useMemo(() => EditorView.updateListener.of((update: ViewUpdate) => {
    if (!update.selectionSet && !update.docChanged) return;
    const head = update.state.selection.main.head;
    const line = update.state.doc.lineAt(head);
    setPosition(head);
    setHeading(/^#{1,6}\s/.exec(line.text)?.[0].trim().length || 0);
    setSlash(!update.state.readOnly && line.text === "/" && head === line.to ? line.from : null);
  }), []);
  const extensions = useMemo(() => [input, shortcuts, listener, markdownHighlighting, WORKSPACE_SEARCH_STYLE,
    ...(mode === "live" ? [liveMarkdown(context, focus), markdownSearchHighlights] : [])],
    [input, shortcuts, listener, mode, context, focus]);
  const onView = useCallback((view: EditorView | null) => { editor.current = view; }, []);
  const handleFindKey = useCallback((event: KeyboardEvent | React.KeyboardEvent) => {
    const view = editor.current;
    const native = "nativeEvent" in event ? event.nativeEvent : event;
    if (!view || event.defaultPrevented || native.isComposing || event.altKey) return;
    const key = event.key.toLowerCase();
    const mod = getAppPlatform() === "macos" ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey;
    const target = event.target instanceof Element ? event.target : null;
    if (target?.closest("input,textarea,select,[contenteditable=true]") && !view.dom.contains(target)) return;
    if (mod && !event.shiftKey && (key === "f" || key === "r")) {
      const previousQuery = getSearchQuery(view.state);
      if (key === "r") openWorkspaceReplacePanel(view);
      else openSearchPanel(view);
      if (previousQuery.search && !previousQuery.eq(getSearchQuery(view.state))) {
        view.dispatch({ effects: setSearchQuery.of(previousQuery) });
      }
    } else if (key === "f3" && !event.ctrlKey && !event.metaKey && searchPanelOpen(view.state)) {
      (event.shiftKey ? findPrevious : findNext)(view);
    } else return;
    event.preventDefault();
    event.stopPropagation();
  }, []);
  useEffect(() => {
    if (!active) return;
    const handleUnfocused = (event: KeyboardEvent) => {
      if (event.target === document.body) {
        handleZoomKey(event);
        handleFindKey(event);
      }
    };
    window.addEventListener("keydown", handleUnfocused);
    return () => window.removeEventListener("keydown", handleUnfocused);
  }, [active, handleFindKey, handleZoomKey]);
  useEffect(() => {
    setPasteStatus(""); setSlash(null); imageRange.current = null; setPosition(0); setEditing(false);
  }, [current.key]);
  useEffect(() => {
    setRenderWarningState({ warnings: [], dismissed: false });
  }, [current.key, current.content, readImage]);
  useEffect(() => { if (requestedMode) { setMode(requestedMode); setEditing(false); } }, [requestedMode]);
  const changeMode = (next: MarkdownMode) => { setSlash(null); setEditing(false); setMode(next); onModeChange?.(next); };
  const insert = (from: number, action: MarkdownFormat | "heading" | "image") => {
    const view = editor.current;
    if (!view || view.state.readOnly || view.state.doc.sliceString(from, from + 1) !== "/") return;
    view.dispatch({ changes: { from, to: from + 1, insert: "" }, selection: { anchor: from } });
    setSlash(null);
    if (action === "heading") setMarkdownHeading(view, 2);
    else if (action === "image") chooseImage();
    else formatMarkdown(view, action);
  };
  return <div ref={root} className={`fv-markdown ${focus ? "fv-md-focus" : ""}`} data-testid="markdown-editor" data-mode={mode} data-editing={mode !== "live" || editing} onKeyDownCapture={handleFindKey}>
    <div className="fv-bar fv-md-toolbar">
      <MarkdownToolbar view={() => editor.current} readOnly={effectiveReadOnly} mode={mode} focus={focus} outline={outline} heading={heading}
        onMode={changeMode} onFocus={() => setFocus(!focus)} onOutline={() => setOutline(!outline)} onImage={chooseImage}
        drawioImport={<MarkdownDrawioImport key={current.key} view={() => editor.current} readOnly={effectiveReadOnly} onError={report} />} />
      {mode === "live" && <button type="button" className="fv-button outline" data-testid="markdown-live-edit" aria-pressed={editing} disabled={current.readOnly || current.truncated}
        onClick={() => setEditing(!editing)}>{editing ? label("完成编辑", "Done editing") : label("编辑", "Edit")}</button>}
      <PreviewAppearanceControl value={appearance} onChange={setAppearance} />
      <MarkdownExportMenu key={`export:${current.key}`} document={current} onError={report} printRequest={printRequest} onExport={owner?.onExport} />
    </div>
    {!renderWarningState.dismissed ? <MarkdownRenderWarnings warnings={renderWarningState.warnings}
      onDismiss={() => setRenderWarningState((currentState) => ({ ...currentState, dismissed: true }))} /> : null}
    <div className="fv-md-wrap">
      {outline && <aside className="fv-md-outline" data-testid="markdown-outline" aria-label={label("大纲", "Outline")}>
        <div className="fv-md-outline-title"><ListTree />{label("大纲", "Outline")}</div>
        {!headings.length && <p className="fv-md-empty-outline">{label("暂无标题", "No headings")}</p>}
        {headings.map((item) => <button type="button" key={item.from} className={activeHeading === item.from ? "on" : ""} data-heading-from={item.from} style={{ paddingLeft: `${8 + (item.level - 1) * 12}px` }} title={item.text} aria-current={activeHeading === item.from ? "location" : undefined} onClick={() => {
          const view = editor.current;
          if (!view) return;
          view.dispatch({ selection: { anchor: item.from }, effects: EditorView.scrollIntoView(item.from, { y: "start" }) });
          view.focus();
          const index = headings.indexOf(item);
          root.current?.querySelector("[data-testid='markdown-preview']")?.querySelectorAll("h1,h2,h3,h4,h5,h6")[index]?.scrollIntoView({ block: "start" });
        }}>{item.text}</button>)}
      </aside>}
      <div ref={main} className="fv-md-main" data-testid={`markdown-${mode}`} data-zoom={zoom} tabIndex={-1}
        style={{ "--fv-md-zoom": zoom / 100 } as CSSProperties} onKeyDownCapture={handleZoomKey}>
      <MarkdownSplit enabled={mode === "split"}>
        <div className={`fv-md-editor-pane ${mode === "live" ? "fv-md-live-pane" : "fv-md-source-pane"}`} data-preview-theme={mode === "live" ? previewTheme : undefined} style={mode === "live" ? previewThemeStyle(previewTheme) : undefined}>
          <EditorSurface document={surfaceDocument} extensions={extensions} onView={onView} onChange={owner?.onChange} onSave={save}
            className={mode === "live" ? "fv-md-live-surface" : "fv-md-source-surface"} nativeSelection={mode === "live" && effectiveReadOnly} createSearchPanel={createWorkspaceSearchPanel} />
          {slash !== null && <MarkdownInsertMenu from={slash} onInsert={insert} onClose={() => setSlash(null)} />}
        </div>
        {mode === "split" ? <MarkdownPreviewPane content={current.content} path={current.path} onError={report} onWarning={onRenderWarning}
          theme={previewTheme} readImage={readImage} label={label} /> : null}
      </MarkdownSplit>
      </div>
    </div>
    <MarkdownDiagramActions key={`visual:${current.key}`} root={root} docPath={current.path} sourceOnDisk={!owner} enabled={active !== false} onError={report} />
    <MarkdownLiveMenu key={`live-menu:${current.key}`} root={root} enabled={active !== false && mode === "live" && effectiveReadOnly} onError={report} />
    {pasteStatus && <div className="fv-md-paste-status" role="status" data-testid="markdown-paste-status">{pasteStatus}<button type="button" aria-label={label("关闭提示", "Dismiss")} onClick={() => setPasteStatus("")}>×</button></div>}
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

function MarkdownPreviewPane({ content, path, onError, onWarning, theme, readImage, label }: {
  content: string;
  path: string;
  onError: (message: string) => void;
  onWarning: (warning: MarkdownRenderWarning) => void;
  theme: "light" | "dark";
  readImage?: (reference: string) => Promise<string>;
  label: MarkdownRenderLabel;
}) {
  const root = useRef<HTMLDivElement>(null);
  const previous = useRef<{ content: string; path: string; readImage: typeof readImage } | null>(null);
  useEffect(() => {
    const container = root.current;
    if (!container) return;
    let cancelled = false;
    const appearanceOnly = previous.current?.content === content && previous.current.path === path && previous.current.readImage === readImage;
    previous.current = { content, path, readImage };
    const rendered = markdownFragment(content);
    const enhancements = enhanceMarkdown(rendered, { docPath: path, theme, readImage, onWarning, label, cancelled: () => cancelled });
    const replace = () => {
      if (cancelled) return;
      const pane = container.parentElement;
      const scrollTop = pane?.scrollTop ?? 0;
      container.replaceChildren(...Array.from(rendered.childNodes));
      if (appearanceOnly && pane) pane.scrollTop = scrollTop;
    };
    // Keep the completed diagram while its new theme renders offscreen. Reading
    // the scroll position at completion also preserves scrolling during a render.
    if (!appearanceOnly) replace();
    void enhancements.then(() => { if (appearanceOnly) replace(); }).catch((error: unknown) => { if (!cancelled) onError(String(error)); });
    return () => { cancelled = true; };
  }, [content, path, onError, onWarning, theme, readImage, label]);
  return <div className="fv-md-preview-pane" data-testid="markdown-preview" data-preview-theme={theme} tabIndex={0} style={previewThemeStyle(theme)} onClick={(event) => {
    const anchor = (event.target as Element).closest("a");
    if (!anchor) return;
    event.preventDefault();
    const href = anchor.getAttribute("href") || "";
    if (/^(https?:|mailto:)/i.test(href)) void openExternalUrl(href).catch((error: unknown) => onError(String(error)));
  }}><div ref={root} className="fv-md-doc" /></div>;
}
