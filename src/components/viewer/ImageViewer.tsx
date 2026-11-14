import { useMemo, useState, type KeyboardEvent } from "react";
import {
  ChevronLeft, ChevronRight, Copy, Download, ExternalLink, FlipHorizontal2, FolderOpen,
  Maximize, Minus, Plus, RotateCcw, RotateCw, Save, ShieldCheck, Code2,
} from "lucide-react";
import { xml } from "@codemirror/lang-xml";
import { writeImagePng, writeText } from "../../lib/clipboard";
import { openExplorer } from "../../lib/explorer/openExplorer";
import { openFile } from "../../lib/openFile";
import { basename, formatBytes, parentPath, sftpOpenPath } from "../../lib/sftp";
import { type ViewerDocument } from "../../lib/viewer";
import { useDocumentStore } from "../../stores/documentStore";
import { EditorSurface } from "./EditorSurface";
import { ImageViewerFilmstrip } from "./ImageViewerFilmstrip";
import { saveImageCopy } from "./ImageViewerExport";
import { imageExtension, imageToPng } from "./ImageViewerImage";
import { useImageDimensions, useImageResource, useImageSiblings } from "./ImageViewerResources";
import { useImageTransform } from "./ImageViewerTransform";
import { useViewerLabels } from "./viewerLabels";
import "./ImageViewer.css";

// Disable autoCloseTags so typing complete <svg>...</svg> markup does not append a duplicate </svg>.
const SVG_EXTENSIONS = [xml({ autoCloseTags: false })];
type ImageViewerProps = { document: ViewerDocument; onError: (message: string) => void; workspaceId?: string };
type SvgMode = "render" | "code" | "split";

export function ImageViewer(props: ImageViewerProps) {
  return <ImageViewerContent key={props.document.key} {...props} />;
}

function ImageViewerContent({ document, onError, workspaceId }: ImageViewerProps) {
  const label = useViewerLabels();
  const svg = document.kind === "svg" || imageExtension(document.path) === "svg";
  const [svgMode, setSvgMode] = useState<SvgMode>("split");
  const [background, setBackground] = useState("checker");
  const [retry, setRetry] = useState(0);
  const [decodeError, setDecodeError] = useState("");
  const [working, setWorking] = useState(false);
  const [notice, setNotice] = useState("");
  const { resource, loading, error } = useImageResource(document, svg, retry);
  const { siblings, error: directoryError } = useImageSiblings(document, retry, !document.readOnlyReason);
  const { image, dimensions, setDimensions } = useImageDimensions(resource?.url);
  const transform = useImageTransform(document.path, dimensions.width, dimensions.height, svgMode);
  const currentIndex = siblings.findIndex((entry) => entry.path === document.path);
  const filename = basename(document.path);
  const viewBox = useMemo(() => svg ? new DOMParser().parseFromString(document.content, "image/svg+xml").documentElement.getAttribute("viewBox") : null, [svg, document.content]);
  const imageError = error || (decodeError === resource?.url ? label("图片损坏或当前 WebView 不支持此格式。", "The image is damaged or this WebView does not support its format.") : "");
  const ready = !!resource && !!dimensions.width && !imageError;
  const zoomText = transform.mode === "fit" ? label("适应", "Fit") : `${Math.round(transform.scale * 100)}%`;

  const run = async (action: () => Promise<unknown>, message?: string) => {
    if (working) return;
    setWorking(true); setNotice("");
    try { await action(); if (message) setNotice(message); }
    catch (cause) { onError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setWorking(false); }
  };
  const navigate = (path: string) => {
    if (path === document.path || document.readOnlyReason) return;
    void openFile({ path }, { context: "viewer", ...(workspaceId ? { workspaceId } : {}) }).catch((cause) => onError(String(cause)));
  };
  const neighbour = (delta: number) => {
    const next = siblings[currentIndex + delta];
    if (next) navigate(next.path);
  };
  const png = () => {
    if (!image.current || !ready) throw new Error(label("图片尚未就绪", "Image is not ready"));
    return imageToPng(image.current, transform.rotation, transform.flipped);
  };
  const exportPng = () => run(async () => {
    const path = await saveImageCopy(await png(), filename.replace(/\.[^.]+$/, "") + ".png", document.path);
    if (path) setNotice(label("已导出 PNG", "PNG exported"));
  });
  const saveAs = () => run(async () => {
    if (!resource) return;
    // SVG copies retain the user's source, never the sanitized rendering.
    const blob = svg ? new Blob([document.content], { type: "image/svg+xml" }) : resource.blob;
    const path = await saveImageCopy(blob, filename, document.path);
    if (path) setNotice(label("已另存副本", "Copy saved"));
  });
  const handleKey = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.nativeEvent.isComposing || event.metaKey || event.ctrlKey || event.altKey ||
      (event.target as HTMLElement).closest("input,textarea,select,[contenteditable=true],.cm-editor")) return;
    if (event.key === "+" || event.key === "=") { event.preventDefault(); transform.zoom(1.2); }
    else if (event.key === "-") { event.preventDefault(); transform.zoom(1 / 1.2); }
    else if (event.key === "0") { event.preventDefault(); transform.reset("actual"); }
    else if (event.key === "ArrowLeft") { event.preventDefault(); neighbour(-1); }
    else if (event.key === "ArrowRight") { event.preventDefault(); neighbour(1); }
  };

  return <div className="image-viewer" data-testid="image-viewer" tabIndex={-1} onKeyDown={handleKey}>
    <div className="fv-bar image-toolbar">
      <button type="button" className="fv-icon-button" data-testid="image-zoom-out" title={label("缩小", "Zoom out")} aria-label={label("缩小", "Zoom out")} disabled={!ready} onClick={() => transform.zoom(1 / 1.2)}><Minus /></button>
      <button type="button" className="fv-button image-zoom" data-testid="image-zoom-actual" title={label("实际大小 (100%)", "Actual size (100%)")} disabled={!ready} onClick={() => transform.reset("actual")}>{zoomText}</button>
      <button type="button" className="fv-icon-button" data-testid="image-zoom-in" title={label("放大", "Zoom in")} aria-label={label("放大", "Zoom in")} disabled={!ready} onClick={() => transform.zoom(1.2)}><Plus /></button>
      <button type="button" className="fv-icon-button" data-testid="image-zoom-fit" title={label("适应窗口", "Fit to window")} aria-label={label("适应窗口", "Fit to window")} disabled={!ready} onClick={() => transform.reset("fit")}><Maximize /></button>
      <span className="fv-separator" />
      <button type="button" className="fv-icon-button" data-testid="image-rotate-left" title={label("向左旋转", "Rotate left")} aria-label={label("向左旋转", "Rotate left")} disabled={!ready} onClick={() => transform.rotate(-1)}><RotateCcw /></button>
      <button type="button" className="fv-icon-button" data-testid="image-rotate-right" title={label("向右旋转", "Rotate right")} aria-label={label("向右旋转", "Rotate right")} disabled={!ready} onClick={() => transform.rotate(1)}><RotateCw /></button>
      <button type="button" className="fv-icon-button" data-testid="image-flip" title={label("水平翻转", "Flip horizontally")} aria-label={label("水平翻转", "Flip horizontally")} aria-pressed={transform.flipped} disabled={!ready} onClick={transform.flip}><FlipHorizontal2 /></button>
      <span className="fv-separator" /><span className="image-muted">{label("背景", "Background")}</span>
      <div className="fv-seg" aria-label={label("背景", "Background")}>{(["checker", "light", "dark"] as const).map((value, index) => <button key={value} type="button" className={background === value ? "on" : ""} aria-pressed={background === value}
        data-testid={`image-background-${value}`} onClick={() => setBackground(value)}>{[label("棋盘", "Checker"), label("浅", "Light"), label("深", "Dark")][index]}</button>)}</div>
      {svg && <><span className="fv-separator" /><div className="fv-seg" aria-label={label("SVG 视图", "SVG view")}>{(["render", "code", "split"] as const).map((value, index) => <button type="button" key={value} className={svgMode === value ? "on" : ""} aria-pressed={svgMode === value}
        data-testid={`image-svg-mode-${value}`} onClick={() => setSvgMode(value)}>{[label("渲染", "Render"), label("代码", "Code"), label("分栏", "Split")][index]}</button>)}</div></>}
      <span className="fv-spacer" />
      {svg && <button type="button" className="fv-button" disabled={document.readOnly || !document.dirty || working} data-testid="image-save" onClick={() => void run(() => useDocumentStore.getState().save(document.path))}><Save />{label("保存", "Save")}</button>}
      <button type="button" className="fv-button" disabled={!!document.readOnlyReason} onClick={() => void run(() => openFile({ path: document.path }, { context: "viewer", mode: "workspace", ...(workspaceId ? { workspaceId } : {}) }))}><Code2 />{label("在 Workspace 中打开", "Open in Workspace")}</button>
      <button type="button" className="fv-button" onClick={() => void run(() => sftpOpenPath(document.path))}><ExternalLink />{label("系统应用", "System app")}</button>
    </div>
    {notice && <div className="image-notice" role="status">{notice}</div>}
    <div className="image-body">
      <div className="image-content">
        <div className={`image-panes image-mode-${svg ? svgMode : "render"}`}>
          {svg && <div className="image-code" hidden={svgMode === "render"}><EditorSurface document={document} extensions={SVG_EXTENSIONS} /></div>}
          <div className={`image-stage image-background-${background}${transform.panning ? " is-panning" : ""}`} hidden={svg && svgMode === "code"}
            data-testid="image-stage" ref={transform.stage} tabIndex={0} aria-label={label("图片画布", "Image canvas")}
            onPointerDown={(event) => { event.currentTarget.focus({ preventScroll: true }); transform.pointerDown(event); }}
            onPointerMove={transform.pointerMove} onPointerUp={transform.pointerEnd} onPointerCancel={transform.pointerEnd} onLostPointerCapture={transform.pointerEnd}>
            {resource && !imageError && <img ref={image} key={resource.url} className="image-render" data-testid="image-render" src={resource.url} alt={filename} draggable={false}
              style={{ transform: `translate(${transform.pan.x}px, ${transform.pan.y}px) scale(${transform.scale}) rotate(${transform.rotation}deg) scaleX(${transform.flipped ? -1 : 1})` }}
              onLoad={(event) => { setDecodeError(""); setDimensions({ width: event.currentTarget.naturalWidth, height: event.currentTarget.naturalHeight }); }}
              onError={() => setDecodeError(resource.url)} />}
            {(loading || document.loading) && <div className="image-state" role="status">{label("正在读取图片…", "Loading image…")}</div>}
            {imageError && <div className="image-state" role="alert"><FileError message={imageError === "image_viewer_limit" || /too_large/i.test(imageError) ? label("图片查看器采用保守的 32 MiB 文件上限（尚未完成真机性能测量）；超出上限请使用系统应用。", "The image viewer uses a conservative 32 MiB file cap (not yet native performance-measured). Open larger files in the system app.") : imageError}
              retry={() => { setDecodeError(""); setRetry((value) => value + 1); }} system={() => void run(() => sftpOpenPath(document.path))} reveal={() => void run(() => openExplorer(parentPath(document.path), workspaceId ? { workspaceId } : undefined))} label={label} /></div>}
            {ready && <><button type="button" className="image-nav image-prev" data-testid="image-prev" disabled={currentIndex <= 0} aria-label={label("上一张", "Previous image")} onClick={() => neighbour(-1)}><ChevronLeft /></button>
              <button type="button" className="image-nav image-next" data-testid="image-next" disabled={currentIndex < 0 || currentIndex >= siblings.length - 1} aria-label={label("下一张", "Next image")} onClick={() => neighbour(1)}><ChevronRight /></button>
              <div className="image-hud">{Math.max(1, currentIndex + 1)} / {siblings.length} · {zoomText} · {dimensions.width} × {dimensions.height}</div></>}
          </div>
        </div>
        <ImageViewerFilmstrip siblings={siblings} resource={resource} path={document.path} label={label("同目录图片", "Neighbouring images")} navigate={navigate} />
      </div>
      <aside className="image-properties" data-testid="image-properties" aria-label={label("图片属性", "Image properties")}>
        <h4>{label("属性", "Properties")}</h4>
        <dl><dt>{label("文件名", "Name")}</dt><dd>{filename}</dd><dt>{label("类型", "Type")}</dt><dd>{svg ? label("SVG 矢量图", "SVG vector image") : resource?.mime ?? imageExtension(filename).toUpperCase()}</dd>
          <dt>{label("尺寸", "Dimensions")}</dt><dd>{dimensions.width ? `${dimensions.width} × ${dimensions.height}` : "—"}</dd>
          {svg && <><dt>viewBox</dt><dd>{viewBox || "—"}</dd></>}<dt>{label("大小", "Size")}</dt><dd>{formatBytes(document.size)}</dd>
          <dt>{label("修改时间", "Modified")}</dt><dd>{document.mtime ? new Date(document.mtime * 1000).toLocaleString() : "—"}</dd></dl>
        {svg && <><h4>{label("安全", "Security")}</h4><div className="image-sanitized" data-testid="image-sanitized"><ShieldCheck />{label("已净化", "Sanitized")}</div>
          <p className="image-muted">{label("脚本、事件属性、外部引用在渲染中被移除；源码保持原样，不被改写。", "Scripts, event handlers and external references are removed from rendering. Your source is kept unchanged.")}</p></>}
        <h4>{label("操作", "Actions")}</h4>
        <div className="image-actions">
          <button type="button" className="fv-button" data-testid="image-copy" disabled={!ready || working} onClick={() => void run(async () => writeImagePng(await png()), label("已复制图片", "Image copied"))}><Copy />{label("复制图片", "Copy image")}</button>
          <button type="button" className="fv-button" data-testid="image-copy-path" disabled={working} onClick={() => void run(() => writeText(document.path), label("已复制路径", "Path copied"))}><Copy />{label("复制路径", "Copy path")}</button>
          <button type="button" className="fv-button" data-testid="image-save-as" disabled={!resource || working} onClick={() => void saveAs()}><Download />{label("另存为…", "Save as…")}</button>
          <button type="button" className="fv-button" data-testid="image-export-png" disabled={!ready || working} onClick={() => void exportPng()}><Download />{label("导出 PNG…", "Export PNG…")}</button>
          <button type="button" className="fv-button" data-testid="image-reveal" disabled={working} onClick={() => void run(() => openExplorer(parentPath(document.path), workspaceId ? { workspaceId } : undefined))}><FolderOpen />{label("在 Explorer 中显示", "Show in Explorer")}</button>
        </div>
        {directoryError && <div className="image-muted"><p title={directoryError}>{label("无法读取同目录图片。", "Cannot list neighbouring images.")}</p><button type="button" className="fv-button" onClick={() => setRetry((value) => value + 1)}>{label("重试", "Retry")}</button></div>}
      </aside>
    </div>
  </div>;
}

function FileError({ message, retry, system, reveal, label }: { message: string; retry: () => void; system: () => void; reveal: () => void; label: (zh: string, en: string) => string }) {
  return <><p>{message}</p><div className="image-error-actions"><button type="button" className="fv-button" onClick={retry}>{label("重试", "Retry")}</button><button type="button" className="fv-button" onClick={system}>{label("系统应用", "System app")}</button><button type="button" className="fv-button" onClick={reveal}>{label("在 Explorer 中显示", "Show in Explorer")}</button></div></>;
}
