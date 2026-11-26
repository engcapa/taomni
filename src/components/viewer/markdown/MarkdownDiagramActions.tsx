import { useCallback, useEffect, useLayoutEffect, useRef, useState, type RefObject } from "react";
import { createPortal } from "react-dom";
import { MoreHorizontal } from "lucide-react";
import { useElementResizeFrame } from "../../../hooks/useElementResizeFrame";
import { writeImagePng, writeText } from "../../../lib/clipboard";
import { markdownBasename } from "../../../lib/markdownAssets";
import { ContextMenu } from "../../ContextMenu";
import { useViewerLabels } from "../viewerLabels";
import { diagramActions, type DiagramAction } from "./diagramActions";
import { DEFAULT_DIAGRAM_VIEW, diagramKind, loadedMarkdownImage, MARKDOWN_DIAGRAM_SELECTOR, MARKDOWN_IMAGE_SELECTOR, snapshotDiagram, snapshotMarkdownImage, type MarkdownVisualSnapshot, type DiagramTransform } from "./diagramModel";
import { diagramPng, diagramSvg } from "./diagramExport";
import { markdownImagePng } from "./markdownImagePng";
import { saveExportBlob } from "./exportFiles";
import { MarkdownDiagramViewer } from "./MarkdownDiagramViewer";
import { singleDiagramDrawio } from "./drawioExport";
import { drawioLink } from "./drawioCodec";
import "./diagram.css";

/** One delegated owner for Live and Split, including asynchronous rerenders.
 * Portals stay outside CodeMirror's widgets and the clipped preview pane. */
export function MarkdownDiagramActions({ root, docPath, sourceOnDisk = true, enabled = true, onError }: {
  root: RefObject<HTMLDivElement | null>; docPath: string; sourceOnDisk?: boolean; enabled?: boolean; onError: (message: string) => void;
}) {
  const label = useViewerLabels();
  const [active, setActive] = useState<HTMLElement | null>(null);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const [viewer, setViewer] = useState<{ snapshot: MarkdownVisualSnapshot; action: DiagramAction; returnFocus: HTMLElement | null } | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [position, setPosition] = useState({ left: 0, top: 0, visible: false });
  const toolbar = useRef<HTMLDivElement>(null);
  const activeElement = useRef(active); activeElement.current = active;
  const state = useRef({ active, menu, viewer }); state.current = { active, menu, viewer };
  const epoch = useRef(0), working = useRef(false);
  const focus = useCallback(() => {
    (state.current.active?.isConnected ? state.current.active : root.current?.querySelector<HTMLElement>(".fv-md-main") || root.current)?.focus();
  }, [root]);
  const closeViewer = () => { setViewer(null); };
  const snapshot = (element: HTMLElement) => {
    const stem = markdownBasename(docPath).replace(/\.(md|markdown)$/i, "");
    const index = (selector: string) => Array.from(root.current?.querySelectorAll(selector) ?? []).indexOf(element) + 1;
    return loadedMarkdownImage(element)
      ? snapshotMarkdownImage(element, `${stem}-image-${index(MARKDOWN_IMAGE_SELECTOR)}`)
      : snapshotDiagram(element, `${stem}-diagram-${index(MARKDOWN_DIAGRAM_SELECTOR)}`);
  };
  const open = (element: HTMLElement, action: DiagramAction = "open") => {
    try {
      const returnFocus = element.isConnected ? element : root.current?.querySelector<HTMLElement>(".fv-md-main") || root.current;
      setActive(element); setMenu(null); setNotice("");
      setViewer({ snapshot: snapshot(element), action, returnFocus });
    } catch (error) { onError(String(error)); }
  };
  const openMenu = (element: HTMLElement, x: number, y: number) => { setActive(element); setMenu({ x, y }); };
  const callbacks = useRef({ open, openMenu, onError }); callbacks.current = { open, openMenu, onError };
  const measure = useCallback(() => {
    const box = activeElement.current?.getBoundingClientRect();
    const visible = Boolean(box && activeElement.current?.isConnected && box.bottom > 0 && box.top < window.innerHeight && box.right > 0 && box.left < window.innerWidth);
    const width = activeElement.current instanceof HTMLImageElement ? 40 : 156;
    const next = { left: Math.max(8, Math.min((box?.right || 0) - width, window.innerWidth - width - 8)), top: Math.max(8, Math.min((box?.top || 0) + 6, window.innerHeight - 44)), visible };
    setPosition((old) => old.left === next.left && old.top === next.top && old.visible === next.visible ? old : next);
  }, []);
  const schedule = useElementResizeFrame(activeElement, measure);
  useLayoutEffect(() => { measure(); }, [active, measure]);
  useEffect(() => {
    const container = root.current;
    if (!container || !enabled) return;
    const find = (target: EventTarget | null) => {
      if (!(target instanceof Element)) return null;
      return target.closest<HTMLElement>(MARKDOWN_DIAGRAM_SELECTOR) ?? (loadedMarkdownImage(target) ? target : null);
    };
    const prepare = () => {
      container.querySelectorAll<HTMLElement>(MARKDOWN_DIAGRAM_SELECTOR).forEach((element) => {
        element.tabIndex = 0; element.setAttribute("role", "figure");
        const name = diagramKind(element) === "drawio" ? "draw.io" : "Mermaid";
        element.setAttribute("aria-label", label(`${name} 图表，回车查看，Shift+F10 打开菜单`, `${name} diagram, Enter to view, Shift+F10 for menu`));
      });
      container.querySelectorAll<HTMLImageElement>(MARKDOWN_IMAGE_SELECTOR).forEach((image) => {
        if (loadedMarkdownImage(image)) image.tabIndex = 0;
      });
      const current = state.current.active;
      if (current && !container.contains(current)) { setActive(null); setMenu(null); setViewer(null); epoch.current++; working.current = false; setBusy(false); }
    };
    const hover = (event: Event) => { const element = find(event.target); if (element && !state.current.menu && !state.current.viewer) setActive(element); };
    const load = (event: Event) => {
      if (!loadedMarkdownImage(event.target instanceof Element ? event.target : null)) return;
      const image = event.target as HTMLImageElement;
      image.tabIndex = 0;
      if (image.matches(":hover")) hover(event);
    };
    const leave = (event: MouseEvent) => {
      if (state.current.menu || state.current.viewer) return;
      const next = event.relatedTarget instanceof Node ? event.relatedTarget : null;
      if (next && (state.current.active?.contains(next) || toolbar.current?.contains(next))) return;
      if (!state.current.active?.contains(document.activeElement)) setActive(null);
    };
    const mouse = (event: MouseEvent) => {
      const element = find(event.target);
      if (!element || element instanceof HTMLImageElement) return;
      event.stopPropagation();
      // Right-button default selection can replace a live Markdown widget
      // after contextmenu opens. Keep selection and the portal's owner stable.
      event.preventDefault();
      if (event.type === "mousedown") element.focus();
    };
    const context = (event: MouseEvent) => { const element = find(event.target); if (element) { event.preventDefault(); event.stopPropagation(); callbacks.current.openMenu(element, event.clientX, event.clientY); } };
    const double = (event: MouseEvent) => { const element = find(event.target); if (element) { event.preventDefault(); event.stopPropagation(); callbacks.current.open(element); } };
    const key = (event: KeyboardEvent) => {
      const element = find(event.target);
      if (!element || event.isComposing || event.metaKey || event.ctrlKey || event.altKey) return;
      if (event.key === "Enter" || event.key === " ") { event.preventDefault(); event.stopPropagation(); callbacks.current.open(element); }
      else if (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10")) {
        event.preventDefault(); event.stopPropagation(); const box = element.getBoundingClientRect(); callbacks.current.openMenu(element, box.left + 12, box.top + 12);
      }
    };
    const observer = new MutationObserver(prepare); observer.observe(container, { childList: true, subtree: true }); prepare();
    container.addEventListener("mouseover", hover); container.addEventListener("focusin", hover);
    container.addEventListener("load", load, true);
    container.addEventListener("mouseout", leave); container.addEventListener("mousedown", mouse, true); container.addEventListener("pointerdown", mouse, true);
    container.addEventListener("contextmenu", context, true); container.addEventListener("dblclick", double, true); container.addEventListener("keydown", key, true);
    window.addEventListener("scroll", schedule, true);
    return () => {
      observer.disconnect(); epoch.current++; working.current = false;
      container.removeEventListener("mouseover", hover); container.removeEventListener("focusin", hover); container.removeEventListener("mouseout", leave);
      container.removeEventListener("load", load, true);
      container.removeEventListener("mousedown", mouse, true); container.removeEventListener("pointerdown", mouse, true); container.removeEventListener("contextmenu", context, true);
      container.removeEventListener("dblclick", double, true); container.removeEventListener("keydown", key, true); window.removeEventListener("scroll", schedule, true);
    };
  }, [root, docPath, enabled, label, schedule]);
  useEffect(() => { setActive(null); setMenu(null); setViewer(null); setBusy(false); setNotice(""); }, [docPath, enabled]);
  const run = async (action: DiagramAction, image: MarkdownVisualSnapshot, transform: DiagramTransform) => {
    if (working.current) return;
    const token = epoch.current; working.current = true; setBusy(true); setNotice("");
    try {
      let result = label("已复制", "Copied");
      if (image.kind === "image") {
        if (action === "copy-image") await writeImagePng(await markdownImagePng(image, transform));
        else if (action === "save-png") {
          const path = await saveExportBlob(`${image.filename}.png`, () => markdownImagePng(image, transform), sourceOnDisk ? docPath : undefined);
          result = path ? label("图片已保存", "Image saved") : label("已取消保存", "Save cancelled");
        }
      } else if (action === "copy-source") await writeText(image.source);
      else if (action === "copy-text") {
        if (!image.text) throw new Error(label("图中没有可复制的文字", "The diagram has no text to copy"));
        await writeText(image.text);
      } else if (action === "copy-image") await writeImagePng(await diagramPng(image, transform));
      else if (action === "copy-drawio-link" || action === "save-drawio") {
        let fallback = 0;
        const generate = async () => { const output = await singleDiagramDrawio(image, transform); fallback = output.fallbackDiagrams; return output; };
        if (action === "copy-drawio-link") await writeText(drawioLink((await generate()).xml));
        else {
          const path = await saveExportBlob(`${image.filename}.drawio`, async () => new Blob([(await generate()).xml], { type: "application/xml;charset=utf-8" }), sourceOnDisk ? docPath : undefined);
          result = path ? label("draw.io 文件已保存", "draw.io file saved") : label("已取消保存", "Save cancelled");
        }
        if (fallback) result += label("；此图类型保留 SVG 和 Mermaid 源码", "; this diagram type retains SVG and Mermaid source");
      }
      else {
        const png = action === "save-png";
        const path = await saveExportBlob(`${image.filename}.${png ? "png" : "svg"}`, async () => png ? diagramPng(image, transform) : new Blob([await diagramSvg(image, transform)], { type: "image/svg+xml" }), sourceOnDisk ? docPath : undefined);
        result = path ? label("图片已保存", "Image saved") : label("已取消保存", "Save cancelled");
      }
      if (token === epoch.current) setNotice(result);
    } catch (error) { if (token === epoch.current) { setNotice(label("操作失败，可重试", "Action failed; try again")); callbacks.current.onError(error instanceof Error ? error.message : String(error)); } }
    finally { if (token === epoch.current) { working.current = false; setBusy(false); } }
  };
  const choose = (id: DiagramAction) => {
    if (!active) return;
    setMenu(null);
    if (/^(save|copy)-/.test(id)) {
      try { void run(id, snapshot(active), DEFAULT_DIAGRAM_VIEW); focus(); }
      catch (error) { onError(String(error)); }
    } else open(active, id);
  };
  const kind = active instanceof HTMLImageElement ? "image" : diagramKind(active);
  const name = kind === "drawio" ? "draw.io" : "Mermaid";
  const entries = diagramActions(label, kind);
  if (!enabled) return null;
  return <>
    {active && position.visible && !viewer && createPortal(<div className="fv fv-md-diagram-tools" ref={toolbar} style={{ left: position.left, top: position.top }} role="toolbar" aria-label={label(`${name} 图片操作`, `${name} image actions`)}
      data-testid={kind === "image" ? "markdown-image-tools" : "markdown-diagram-tools"} onMouseLeave={(event) => { if (!menu && !active.contains(event.relatedTarget instanceof Node ? event.relatedTarget : null) && !active.contains(document.activeElement)) setActive(null); }}>
      {entries.filter((entry) => ["open", "save-svg", "copy-text"].includes(entry.id)).map(({ id, title, Icon }) => <button key={id} type="button" className="fv-icon-button" title={title} aria-label={title} data-testid={`markdown-diagram-${id}`} disabled={busy} onClick={() => choose(id)}><Icon /></button>)}
      {kind !== "image" && <button type="button" className="fv-icon-button" data-testid="markdown-diagram-more" aria-haspopup="menu" aria-expanded={!!menu} title={label("更多查看操作", "More viewing actions")} aria-label={label("更多查看操作", "More viewing actions")}
        onClick={(event) => { const box = event.currentTarget.getBoundingClientRect(); openMenu(active, box.left, box.bottom); }}><MoreHorizontal /></button>}
    </div>, document.body)}
    {menu && active && (
      <ContextMenu
        x={menu.x}
        y={menu.y}
        testId="markdown-diagram-menu"
        ariaLabel={label(`${name} 图片菜单`, `${name} image menu`)}
        className="fv fv-menu fv-md-diagram-menu"
        closeOnTab
        dismissOnFocusOut
        items={entries.map(({ id, title, Icon }) => ({
          label: title,
          testId: `markdown-diagram-menu-${id}`,
          icon: <Icon />,
          disabled: busy,
          onClick: () => choose(id),
        }))}
        onClose={(reason) => {
          setMenu(null);
          if (reason === "escape") focus();
        }}
      />
    )}
    {notice && !viewer && <div className="fv-md-diagram-notice" role="status" data-testid="markdown-diagram-status">{notice}</div>}
    {viewer && createPortal(<MarkdownDiagramViewer snapshot={viewer.snapshot} initialAction={viewer.action} busy={busy} notice={notice} label={label} returnFocus={viewer.returnFocus} onAction={(action, image, transform) => { void run(action, image, transform); }} onClose={closeViewer} />, document.body)}
  </>;
}
