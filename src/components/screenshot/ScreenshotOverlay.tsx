import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { CSSProperties, MouseEvent as ReactMouseEvent, ReactNode } from "react";
import {
  ArrowUpRight,
  Check,
  ChevronDown,
  Circle,
  Crop,
  Download,
  Droplets,
  Eraser,
  Highlighter,
  LayoutGrid,
  Lasso,
  ListOrdered,
  Maximize,
  MessageCircle,
  MousePointer2,
  MoreHorizontal,
  SlidersHorizontal,
  Minus,
  Pencil,
  Pin,
  Pipette,
  Redo2,
  ScanText,
  ScrollText,
  ShieldAlert,
  Square,
  Stamp,
  Type,
  Trash2,
  Undo2,
  Video,
  X,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { listSystemFonts } from "../../lib/ipc";
import { ScrollCaptureResult } from "./ScrollCaptureResult";
import { ImageEditPanel } from "./ImageEditPanel";
import { drawEdited, editedSize, paintWatermark, type ImageEdit, type WatermarkSettings } from "../../lib/screenshotImage";
import { useT } from "../../lib/i18n";
import { formatUnknownError } from "../../lib/appDialogs";
import {
  autoRedact,
  captureFull,
  closeScreenshotOverlay,
  copyImageToClipboard,
  fetchOverlayInit,
  loadScreenshotUrl,
  normalizeRect,
  ocrImage,
  openImageEditor,
  pinToScreen,
  revokeScreenshotUrl,
  saveDataUrl,
  saveImageToFile,
  scrollCapture,
  scrollPlan,
  type PhysicalRect,
  startRecording,
  toPhysicalRect,
  updateOverlayImage,
  type OverlayInit,
  type RecordFormat,
  type ScreenshotPoint,
  type ScrollMode,
} from "../../lib/screenshot";
import { contourBounds, contourPath, maskContour, pointInContour, transformContour, validContour } from "../../lib/screenshotSelection";
import { screenshotShortcutLabel, useScreenshotShortcutStore } from "../../lib/screenshotShortcut";
import {
  AnnotationCanvas,
  FONT_STACK,
  FILLABLE_TOOLS,
  type EraserMode,
  type AnnotationCanvasHandle,
  type AnnotationTool,
  type CssRect,
  type Shape,
} from "./AnnotationCanvas";

type Phase = "loading" | "select" | "annotate" | "busy" | "preview";
interface ImageSnapshot {
  img: HTMLImageElement; url: string; selection: CssRect | null; contour: ScreenshotPoint[] | null;
  result: { frames: number; w: number; h: number } | null; shapes: Shape[];
}

/** Selections smaller than this (CSS px) are treated as a click. */
const MIN_SEL = 6;
const HANDLE = 8;

const COLORS: { value: string; testid: string; titleKey: string }[] = [
  { value: "#ff4d4f", testid: "screenshot-color-red", titleKey: "screenshot.colorRed" },
  { value: "#fa8c16", testid: "screenshot-color-orange", titleKey: "screenshot.colorOrange" },
  { value: "#faad14", testid: "screenshot-color-yellow", titleKey: "screenshot.colorYellow" },
  { value: "#52c41a", testid: "screenshot-color-green", titleKey: "screenshot.colorGreen" },
  { value: "#13c2c2", testid: "screenshot-color-cyan", titleKey: "screenshot.colorCyan" },
  { value: "#1677ff", testid: "screenshot-color-blue", titleKey: "screenshot.colorBlue" },
  { value: "#722ed1", testid: "screenshot-color-purple", titleKey: "screenshot.colorPurple" },
  { value: "#eb2f96", testid: "screenshot-color-pink", titleKey: "screenshot.colorPink" },
  { value: "#8c8c8c", testid: "screenshot-color-gray", titleKey: "screenshot.colorGray" },
  { value: "#000000", testid: "screenshot-color-black", titleKey: "screenshot.colorBlack" },
  { value: "#ffffff", testid: "screenshot-color-white", titleKey: "screenshot.colorWhite" },
];

const TOOLS: { tool: AnnotationTool; testid: string; titleKey: string; Icon: LucideIcon }[] = [
  { tool: "move", testid: "screenshot-tool-move", titleKey: "screenshot.toolMove", Icon: MousePointer2 },
  { tool: "rect", testid: "screenshot-tool-rect", titleKey: "screenshot.toolRect", Icon: Square },
  { tool: "ellipse", testid: "screenshot-tool-ellipse", titleKey: "screenshot.toolEllipse", Icon: Circle },
  { tool: "arrow", testid: "screenshot-tool-arrow", titleKey: "screenshot.toolArrow", Icon: ArrowUpRight },
  { tool: "line", testid: "screenshot-tool-line", titleKey: "screenshot.toolLine", Icon: Minus },
  { tool: "pen", testid: "screenshot-tool-pen", titleKey: "screenshot.toolPen", Icon: Pencil },
  { tool: "highlighter", testid: "screenshot-tool-highlighter", titleKey: "screenshot.toolHighlighter", Icon: Highlighter },
  { tool: "text", testid: "screenshot-tool-text", titleKey: "screenshot.toolText", Icon: Type },
  { tool: "balloon", testid: "screenshot-tool-balloon", titleKey: "screenshot.toolBalloon", Icon: MessageCircle },
  { tool: "mosaic", testid: "screenshot-tool-mosaic", titleKey: "screenshot.toolMosaic", Icon: LayoutGrid },
  { tool: "blur", testid: "screenshot-tool-blur", titleKey: "screenshot.toolBlur", Icon: Droplets },
  { tool: "number", testid: "screenshot-tool-number", titleKey: "screenshot.toolNumber", Icon: ListOrdered },
  { tool: "eraser", testid: "screenshot-tool-eraser", titleKey: "screenshot.toolEraser", Icon: Eraser },
];

const LINE_WIDTHS = [2, 4, 8];

type Handle = "move" | "n" | "s" | "e" | "w" | "ne" | "nw" | "se" | "sw";

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("failed to load screenshot image"));
    image.src = src;
  });
}

/** Load a backend artifact into an image backed by a same-origin URL. */
async function loadArtifact(path: string): Promise<{ img: HTMLImageElement; url: string }> {
  const url = await loadScreenshotUrl(path);
  try {
    return { img: await loadImage(url), url };
  } catch (e) {
    revokeScreenshotUrl(url);
    throw e;
  }
}

/** Crop a PNG data URL to a device-pixel rect. */
function cropDataUrl(dataUrl: string, r: { x: number; y: number; width: number; height: number }): Promise<string> {
  return loadImage(dataUrl).then((image) => {
    const c = document.createElement("canvas");
    c.width = r.width;
    c.height = r.height;
    const ctx = c.getContext("2d");
    if (!ctx) throw new Error("canvas 2d context unavailable");
    ctx.drawImage(image, r.x, r.y, r.width, r.height, 0, 0, r.width, r.height);
    return c.toDataURL("image/png");
  });
}

export type { WatermarkSettings } from "../../lib/screenshotImage";

/** Apply the same seeded, scattered watermark layout to every export. */
function applyWatermark(dataUrl: string, wm: WatermarkSettings): Promise<string> {
  return loadImage(dataUrl).then((image) => {
    const c = document.createElement("canvas");
    c.width = image.naturalWidth;
    c.height = image.naturalHeight;
    const ctx = c.getContext("2d");
    if (!ctx) throw new Error("canvas 2d context unavailable");
    ctx.drawImage(image, 0, 0);
    paintWatermark(ctx, c.width, c.height, wm);
    return c.toDataURL("image/png");
  });
}

function ToolButton({
  testid,
  title,
  active,
  disabled,
  onClick,
  children,
}: {
  testid: string;
  title: string;
  active?: boolean;
  disabled?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      data-testid={testid}
      title={title}
      aria-label={title}
      aria-pressed={active}
      disabled={disabled}
      onClick={onClick}
      className={`w-8 h-8 shrink-0 rounded-lg flex items-center justify-center transition-colors disabled:opacity-40 ${
        active ? "" : "hover:bg-[var(--taomni-hover)]"
      }`}
      style={{
        background: active ? "var(--taomni-accent)" : undefined,
        color: active ? "#ffffff" : "var(--taomni-text)",
      }}
    >
      {children}
    </button>
  );
}

/** Feishu-style magnifier: 120px box, 4x zoom, crosshair, pixel color. */
function Magnifier({
  img,
  cursor,
  sx,
  sy,
  viewport,
}: {
  img: HTMLImageElement;
  cursor: { x: number; y: number };
  sx: number;
  sy: number;
  viewport: { w: number; h: number };
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const [hex, setHex] = useState("");
  const size = 120;

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const zoom = 4;
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) return;
    const srcW = (size / zoom) * sx;
    const srcH = (size / zoom) * sy;
    ctx.imageSmoothingEnabled = false;
    ctx.fillStyle = "#000";
    ctx.fillRect(0, 0, size, size);
    ctx.drawImage(img, cursor.x * sx - srcW / 2, cursor.y * sy - srcH / 2, srcW, srcH, 0, 0, size, size);
    try {
      const px = ctx.getImageData(size / 2, size / 2, 1, 1).data;
      setHex(`#${[px[0], px[1], px[2]].map((v) => v.toString(16).padStart(2, "0")).join("").toUpperCase()}`);
    } catch {
      setHex("");
    }
    ctx.strokeStyle = "rgba(22, 119, 255, 0.9)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(size / 2 + 0.5, 0);
    ctx.lineTo(size / 2 + 0.5, size);
    ctx.moveTo(0, size / 2 + 0.5);
    ctx.lineTo(size, size / 2 + 0.5);
    ctx.stroke();
  }, [img, cursor, sx, sy]);

  let left = cursor.x + 18;
  let top = cursor.y + 18;
  if (cursor.x > viewport.w - size - 24) left = cursor.x - size - 18;
  if (cursor.y > viewport.h - size - 60) top = cursor.y - size - 54;

  return (
    <div
      data-testid="screenshot-magnifier"
      style={{ position: "fixed", zIndex: 60, left, top, width: size, pointerEvents: "none" }}
    >
      <div
        style={{
          width: size,
          height: size,
          borderRadius: 8,
          overflow: "hidden",
          border: "1px solid rgba(255, 255, 255, 0.65)",
          boxShadow: "0 4px 18px rgba(0, 0, 0, 0.55)",
        }}
      >
        <canvas ref={canvasRef} style={{ display: "block", width: size, height: size }} />
      </div>
      <div
        className="mt-1 rounded px-1.5 py-0.5 text-center font-mono text-[11px]"
        style={{ background: "rgba(0,0,0,0.75)", color: "#fff" }}
      >
        {Math.round(cursor.x * sx)}, {Math.round(cursor.y * sy)} {hex}
      </div>
    </div>
  );
}

function clampRect(r: CssRect, vw: number, vh: number): CssRect {
  const w = Math.min(r.w, vw);
  const h = Math.min(r.h, vh);
  return { x: Math.min(Math.max(0, r.x), vw - w), y: Math.min(Math.max(0, r.y), vh - h), w, h };
}

/** Apply a handle drag of (dx, dy) to the rect captured at drag start. */
function dragRect(start: CssRect, handle: Handle, dx: number, dy: number, vw: number, vh: number): CssRect {
  if (handle === "move") {
    return clampRect({ ...start, x: start.x + dx, y: start.y + dy }, vw, vh);
  }
  let x1 = start.x;
  let y1 = start.y;
  let x2 = start.x + start.w;
  let y2 = start.y + start.h;
  if (handle.includes("w")) x1 += dx;
  if (handle.includes("e")) x2 += dx;
  if (handle.includes("n")) y1 += dy;
  if (handle.includes("s")) y2 += dy;
  const clamp = (v: number, max: number) => Math.min(Math.max(0, v), max);
  return normalizeRect({ x: clamp(x1, vw), y: clamp(y1, vh) }, { x: clamp(x2, vw), y: clamp(y2, vh) });
}

const HANDLE_CURSORS: Record<Handle, string> = {
  move: "move",
  n: "ns-resize",
  s: "ns-resize",
  e: "ew-resize",
  w: "ew-resize",
  ne: "nesw-resize",
  sw: "nesw-resize",
  nw: "nwse-resize",
  se: "nwse-resize",
};

export function ScreenshotOverlay() {
  const t = useT();
  const stopShortcut = screenshotShortcutLabel(useScreenshotShortcutStore((s) => s.status));
  const [init, setInit] = useState<OverlayInit | null>(null);
  const [img, setImg] = useState<HTMLImageElement | null>(null);
  const [imgUrl, setImgUrl] = useState<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [phase, setPhase] = useState<Phase>("loading");
  const [sel, setSel] = useState<CssRect | null>(null);
  const [selectionMode, setSelectionMode] = useState<"rectangle" | "freehand">("rectangle");
  const [contour, setContour] = useState<ScreenshotPoint[] | null>(null);
  const [tool, setTool] = useState<AnnotationTool>("select");
  const [color, setColor] = useState(COLORS[0].value);
  const [colorDraft, setColorDraft] = useState(COLORS[0].value);
  useEffect(() => setColorDraft(color), [color]);
  const [lineWidth, setLineWidth] = useState(4);
  const [fill, setFill] = useState(false);
  const [fillableSelected, setFillableSelected] = useState(false);
  const [eraserMode, setEraserMode] = useState<EraserMode>("partial");
  const [drawing, setDrawing] = useState(false);
  // Keep the tool family together by default; the panel wraps/scrolls instead
  // of moving actions into different popover locations. The button remains as
  // an explicit compact-mode hook for small screens.
  const [moreOpen, setMoreOpen] = useState(true);
  const [editOpen, setEditOpen] = useState(false);
  const [editBusy, setEditBusy] = useState(false);
  const [imageUndo, setImageUndo] = useState<ImageSnapshot[]>([]);
  const [imageRedo, setImageRedo] = useState<ImageSnapshot[]>([]);
  const [fontFamily, setFontFamily] = useState(FONT_STACK);
  const [fontSize, setFontSize] = useState(18);
  const [systemFonts, setSystemFonts] = useState<string[]>([]);
  const [textSelected, setTextSelected] = useState(false);
  const [scrollResult, setScrollResult] = useState<{ frames: number; w: number; h: number } | null>(null);
  const [canUndo, setCanUndo] = useState(false);
  const [canRedo, setCanRedo] = useState(false);
  const [annotationSelected, setAnnotationSelected] = useState(false);
  const [scrollConfirm, setScrollConfirm] = useState(false);
  const [scrollMode, setScrollMode] = useState<ScrollMode>("manual");
  const [plannedRegion, setPlannedRegion] = useState<PhysicalRect | null>(null);
  const [planningScroll, setPlanningScroll] = useState(false);
  const onAnnotationSelection = useCallback((shape: Shape | null) => {
    setAnnotationSelected(!!shape);
    setTextSelected(shape?.kind === "text");
    const fillable = !!shape && FILLABLE_TOOLS.includes(shape.kind);
    setFillableSelected(fillable);
    if (fillable && shape && "filled" in shape) setFill(!!shape.filled);
    else if (fillable) setFill(false);
    if (shape?.kind === "text") { setFontFamily(shape.fontFamily ?? FONT_STACK); setFontSize(shape.fontSize); }
    if (shape) { setColor(shape.color); setLineWidth(shape.lineWidth); }
  }, []);
  const [cursor, setCursor] = useState<{ x: number; y: number } | null>(null);
  const [dragging, setDragging] = useState(false);
  const [recordOpen, setRecordOpen] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [scrollError, setScrollError] = useState<string | null>(null);
  const [viewport, setViewport] = useState({ w: window.innerWidth, h: window.innerHeight });
  const [pickerMode, setPickerMode] = useState(false);
  const [pickerInfo, setPickerInfo] = useState<{ x: number; y: number; hex: string; rgb: string } | null>(null);
  const pickerCacheRef = useRef<ImageData | null>(null);
  const [watermarkOpen, setWatermarkOpen] = useState(false);
  const [watermark, setWatermark] = useState<WatermarkSettings | null>(null);
  const [watermarkText, setWatermarkText] = useState("");
  const [watermarkOpacity, setWatermarkOpacity] = useState(0.16);
  const [watermarkColor, setWatermarkColor] = useState("#ffffff");
  const [ocrOpen, setOcrOpen] = useState(false);
  const [ocrText, setOcrText] = useState("");
  const [ocrLoading, setOcrLoading] = useState(false);
  const [toolbarPos, setToolbarPos] = useState<{ left: number; top: number } | null>(null);
  const canvasRef = useRef<AnnotationCanvasHandle | null>(null);
  const pendingShapes = useRef<Shape[] | null>(null);
  useLayoutEffect(() => {
    if (pendingShapes.current && canvasRef.current) {
      canvasRef.current.restore(pendingShapes.current);
      pendingShapes.current = null;
    }
  });
  const recordMenuRef = useRef<HTMLDivElement | null>(null);
  const recordButtonRef = useRef<HTMLDivElement | null>(null);
  const [recordPos, setRecordPos] = useState({ left: 8, top: 8 });
  const watermarkPanelRef = useRef<HTMLDivElement | null>(null);
  const watermarkButtonRef = useRef<HTMLDivElement | null>(null);
  const [watermarkPos, setWatermarkPos] = useState({ left: 8, top: 8 });
  const toolbarRef = useRef<HTMLDivElement | null>(null);
  /** Region-select / move / resize drag in progress. */
  const dragRef = useRef<{
    kind: "select" | "freehand" | Handle;
    origin: ScreenshotPoint;
    start: CssRect;
    current: CssRect;
    points: ScreenshotPoint[] | null;
  } | null>(null);
  const toastTimer = useRef<number | null>(null);
  const busyRef = useRef(false);

  useEffect(() => {
    if (tool !== "text" && !textSelected) return;
    let disposed = false;
    void listSystemFonts().then((fonts) => { if (!disposed) setSystemFonts(fonts); }).catch(() => undefined);
    return () => { disposed = true; };
  }, [tool, textSelected]);

  const imageSize = scrollResult ?? viewport;

  /** CSS px -> physical px, per axis (backend image is physical pixels). */
  const sx = img ? img.naturalWidth / Math.max(1, imageSize.w) : 1;
  const sy = img ? img.naturalHeight / Math.max(1, imageSize.h) : 1;
  const bounds = img ? { width: img.naturalWidth, height: img.naturalHeight } : undefined;
  const toPhysical = (r: CssRect) => toPhysicalRect(r, sx, sy, bounds);

  const showToast = useCallback((msg: string) => {
    setToast(msg);
    if (toastTimer.current) window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(null), 2500);
  }, []);

  useEffect(
    () => () => {
      if (toastTimer.current) window.clearTimeout(toastTimer.current);
    },
    [],
  );
  // Image undo keeps previous backgrounds alive. Revoke all owned URLs only
  // on unmount, not when selecting the next edit snapshot.
  const ownedUrls = useRef(new Set<string>());
  useEffect(() => { if (imgUrl) ownedUrls.current.add(imgUrl); }, [imgUrl]);
  useEffect(() => () => { ownedUrls.current.forEach(revokeScreenshotUrl); }, []);

  const close = useCallback(() => {
    void closeScreenshotOverlay().catch(() => undefined);
  }, []);

  // Init: prefer the pending overlay payload; fall back to a live fullscreen
  // capture so the overlay never renders blank (dev/QA direct open).
  useEffect(() => {
    let cancelled = false;
    (async () => {
      let data: OverlayInit;
      try {
        data = await fetchOverlayInit();
      } catch {
        const file = await captureFull();
        data = { path: file.path, displayId: "", width: file.width, height: file.height, scaleFactor: 1 };
      }
      if (cancelled) return;
      const loaded = await loadArtifact(data.path);
      if (cancelled) {
        revokeScreenshotUrl(loaded.url);
        return;
      }
      setInit(data);
      setImg(loaded.img);
      setImgUrl(loaded.url);
      if (data.document) {
        const size = { w: loaded.img.naturalWidth, h: loaded.img.naturalHeight };
        setScrollResult({ frames: 0, ...size }); setSel({ x: 0, y: 0, ...size }); setTool("move"); setPhase("preview");
      } else if (data.windowRegion) {
        const s = data.windowRegion;
        setSel({ x: s.x * window.innerWidth / data.width, y: s.y * window.innerHeight / data.height,
          w: s.width * window.innerWidth / data.width, h: s.height * window.innerHeight / data.height });
        setPhase("annotate");
      } else setPhase("select");
    })().catch((e: unknown) => {
      if (!cancelled) setLoadError(formatUnknownError(e));
    });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const onResize = () => setViewport({ w: window.innerWidth, h: window.innerHeight });
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  // ---------------------------------------------------------------------
  // Color picker
  // ---------------------------------------------------------------------

  const enterPickerMode = useCallback(() => {
    if (!img) return;
    try {
      const c = document.createElement("canvas");
      c.width = img.naturalWidth;
      c.height = img.naturalHeight;
      const ctx = c.getContext("2d", { willReadFrequently: true });
      if (!ctx) return;
      ctx.drawImage(img, 0, 0);
      pickerCacheRef.current = ctx.getImageData(0, 0, c.width, c.height);
      setPickerInfo(null);
      setPickerMode(true);
    } catch {
      showToast(t("screenshot.pickerUnavailable"));
    }
  }, [img, showToast, t]);

  const exitPickerMode = useCallback(() => {
    setPickerMode(false);
    setPickerInfo(null);
    pickerCacheRef.current = null;
  }, []);

  const handlePickerMove = (e: ReactMouseEvent) => {
    const cache = pickerCacheRef.current;
    if (!cache) return;
    const preview = scrollResult ? document.querySelector('[data-testid="screenshot-scroll-result-image"]')?.getBoundingClientRect() : null;
    const x = Math.max(0, Math.min(cache.width - 1, Math.floor(preview ? (e.clientX - preview.left) * cache.width / preview.width : e.clientX * sx)));
    const y = Math.max(0, Math.min(cache.height - 1, Math.floor(preview ? (e.clientY - preview.top) * cache.height / preview.height : e.clientY * sy)));
    const i = (y * cache.width + x) * 4;
    const [r, g, b] = [cache.data[i], cache.data[i + 1], cache.data[i + 2]];
    const hex = `#${[r, g, b].map((v) => v.toString(16).padStart(2, "0")).join("").toUpperCase()}`;
    setPickerInfo({ x: e.clientX, y: e.clientY, hex, rgb: `rgb(${r}, ${g}, ${b})` });
  };

  const handlePickerPick = async () => {
    if (!pickerInfo) return;
    try {
      const { writeText } = await import("../../lib/clipboard");
      await writeText(pickerInfo.hex);
      showToast(t("screenshot.pickerCopied", { color: pickerInfo.hex }));
    } catch {
      showToast(t("screenshot.pickerCopyFailed"));
    }
    exitPickerMode();
  };

  // ---------------------------------------------------------------------
  // Selection
  // ---------------------------------------------------------------------

  const fullscreenSelect = useCallback(() => {
    setSel({ x: 0, y: 0, w: imageSize.w, h: imageSize.h });
    setContour(null);
    setSelectionMode("rectangle");
    setTool("select");
    setPhase("annotate");
  }, [imageSize.w, imageSize.h]);

  /** Drop the selection and annotations; back to region selection. */
  const resetSelection = useCallback(() => {
    setScrollError(null);
    canvasRef.current?.clear();
    dragRef.current = null;
    setDragging(false);
    setSel(null);
    setContour(null);
    setTool("select");
    setRecordOpen(false);
    setWatermarkOpen(false);
    setPhase("select");
  }, []);

  const changeSelectionMode = (mode: "rectangle" | "freehand") => {
    if (mode === selectionMode) return;
    exitPickerMode();
    setRecordOpen(false);
    setSelectionMode(mode);
    setTool("select");
    if (mode === "rectangle") setContour(null);
    else resetSelection();
  };

  const pointInSel = (x: number, y: number): boolean =>
    sel !== null && (contour ? pointInContour({ x, y }, contour)
      : x >= sel.x && x <= sel.x + sel.w && y >= sel.y && y <= sel.y + sel.h);

  const startRegionDrag = (x: number, y: number) => {
    const start = { x, y, w: 0, h: 0 };
    const points = selectionMode === "freehand" ? [{ x, y }] : null;
    dragRef.current = { kind: points ? "freehand" : "select", origin: { x, y }, start, current: start, points };
    setContour(points);
    setDragging(true);
    setSel(start);
  };

  /** Mousedown on the base layer (outside any shape tool). */
  const handleSelectMouseDown = (e: ReactMouseEvent) => {
    if (e.button !== 0 || phase === "busy" || phase === "loading") return;
    if (phase === "select") {
      startRegionDrag(e.clientX, e.clientY);
    } else if (phase === "annotate" && !pointInSel(e.clientX, e.clientY)) {
      // Feishu: pressing outside the selection starts a new one.
      resetSelection();
      startRegionDrag(e.clientX, e.clientY);
    }
  };

  const startHandleDrag = (e: ReactMouseEvent, handle: Handle) => {
    if (e.button !== 0 || !sel) return;
    e.stopPropagation();
    e.preventDefault();
    dragRef.current = { kind: handle, origin: { x: e.clientX, y: e.clientY }, start: sel, current: sel, points: contour };
    setDragging(true);
  };

  useEffect(() => {
    const onMove = (e: MouseEvent) => {
      setCursor({ x: e.clientX, y: e.clientY });
      const d = dragRef.current;
      if (!d) return;
      const point = {
        x: Math.min(Math.max(0, e.clientX), viewport.w),
        y: Math.min(Math.max(0, e.clientY), viewport.h),
      };
      if (d.kind === "freehand" && d.points) {
        const last = d.points[d.points.length - 1];
        if (Math.hypot(point.x - last.x, point.y - last.y) >= 1) {
          // Keep memory/render cost bounded for long gestures without losing the endpoint.
          if (d.points.length >= 4096) d.points = d.points.filter((_, i) => i % 2 === 0);
          d.points.push(point);
        }
        d.current = contourBounds(d.points) ?? d.start;
        setContour([...d.points]);
      } else {
        d.current = d.kind === "select"
          ? normalizeRect(d.origin, point)
          : dragRect(d.start, d.kind as Handle, point.x - d.origin.x, point.y - d.origin.y, viewport.w, viewport.h);
        if (d.points) setContour(transformContour(d.points, d.start, d.current));
      }
      setSel(d.current);
    };
    const onUp = (e: MouseEvent) => {
      const d = dragRef.current;
      if (!d) return;
      onMove(e);
      dragRef.current = null;
      setDragging(false);
      const selecting = d.kind === "select" || d.kind === "freehand";
      if (d.current.w < MIN_SEL || d.current.h < MIN_SEL
        || (d.kind === "freehand" && !validContour(d.points ?? [], MIN_SEL))) {
        setSel(selecting ? null : d.start);
        setContour(selecting ? null : d.points);
        if (selecting) setPhase("select");
      } else if (selecting) {
        setTool("select");
        setPhase("annotate");
      }
    };
    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
    return () => {
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };
  }, [viewport.w, viewport.h]);

  const handleDoubleClick = (e: ReactMouseEvent) => {
    if (phase === "busy" || phase === "loading" || !img) return;
    if (phase === "select") {
      fullscreenSelect();
    } else if (phase === "annotate" && pointInSel(e.clientX, e.clientY) && tool === "select") {
      void handleCopy();
    }
  };

  // ---------------------------------------------------------------------
  // Output
  // ---------------------------------------------------------------------

  /** Composite base + annotations at natural size, cropped to the selection. */
  const exportCropped = async (includeWatermark = true): Promise<string> => {
    const canvas = canvasRef.current;
    if (!canvas || !img) throw new Error("screenshot not ready");
    const full = canvas.exportDataUrl(img, sx, sy);
    let out = sel ? await cropDataUrl(full, toPhysical(sel)) : full;
    if (includeWatermark && watermark && watermark.text.trim()) out = await applyWatermark(out, watermark);
    if (contour && sel) {
      const image = await loadImage(out);
      const c = document.createElement("canvas");
      c.width = image.naturalWidth;
      c.height = image.naturalHeight;
      const ctx = c.getContext("2d");
      if (!ctx) throw new Error("canvas 2d context unavailable");
      ctx.drawImage(image, 0, 0);
      maskContour(ctx, contour, sx, sy, toPhysical(sel));
      out = c.toDataURL("image/png");
    }
    return out;
  };

  /** Run an output action once (buttons + shortcuts can race). */
  const runBusy = async (action: () => Promise<void>) => {
    if (busyRef.current) return;
    busyRef.current = true;
    try {
      await action();
    } finally {
      busyRef.current = false;
    }
  };

  const imageSnapshot = (): ImageSnapshot | null => img && imgUrl ? {
    img, url: imgUrl, selection: sel, contour, result: scrollResult, shapes: canvasRef.current?.snapshot() ?? [],
  } : null;

  const restoreImage = (snapshot: ImageSnapshot) => {
    setImg(snapshot.img); setImgUrl(snapshot.url); setSel(snapshot.selection); setContour(snapshot.contour);
    setScrollResult(snapshot.result); setPhase(snapshot.result ? "preview" : "annotate");
    setTool("move"); pendingShapes.current = snapshot.shapes;
  };
  const undoImage = () => {
    const current = imageSnapshot(), previous = imageUndo.at(-1);
    if (!current || !previous || editBusy) return;
    setImageRedo((list) => [...list, current]); setImageUndo((list) => list.slice(0, -1)); restoreImage(previous);
  };
  const redoImage = () => {
    const current = imageSnapshot(), next = imageRedo.at(-1);
    if (!current || !next || editBusy) return;
    setImageUndo((list) => [...list, current]); setImageRedo((list) => list.slice(0, -1)); restoreImage(next);
  };
  const editImage = (edit: ImageEdit) => runBusy(async () => {
    const before = imageSnapshot();
    if (!before) return;
    setEditBusy(true);
    try {
      const image = await loadImage(await exportCropped(false));
      const size = editedSize(image.naturalWidth, image.naturalHeight, edit);
      const canvas = document.createElement("canvas"); canvas.width = size.width; canvas.height = size.height;
      const ctx = canvas.getContext("2d"); if (!ctx) throw new Error("canvas unavailable");
      drawEdited(ctx, image, image.naturalWidth, image.naturalHeight, edit);
      const url = canvas.toDataURL("image/png");
      const loaded = await loadImage(url);
      setImageUndo((list) => [...list.slice(-7), before]); setImageRedo([]);
      // Edits bake annotations into a new background. Image undo retains the
      // original vector shapes; restore them after switching canvas hosts.
      setImg(loaded); setImgUrl(url); setScrollResult({ frames: scrollResult?.frames ?? 0, w: size.width, h: size.height });
      setSel({ x: 0, y: 0, w: size.width, h: size.height }); setContour(null);
      canvasRef.current?.clear(); setTool("move"); setPhase("preview");
    } catch (e) { showToast(formatUnknownError(e)); }
    finally { setEditBusy(false); }
  });
  const externalEdit = (choose: boolean) => runBusy(async () => {
    try {
      let editor: string | undefined;
      if (choose) {
        const { open } = await import("@tauri-apps/plugin-dialog");
        const selected = await open({ title: t("screenshot.chooseEditor"), multiple: false, directory: false });
        if (typeof selected !== "string") return;
        editor = selected;
      }
      const file = await saveDataUrl(await exportCropped());
      await openImageEditor(file.path, editor);
      await closeScreenshotOverlay();
    } catch (e) { showToast(formatUnknownError(e)); }
  });

  const handleCopy = () =>
    runBusy(async () => {
      try {
        const file = await saveDataUrl(await exportCropped());
        await copyImageToClipboard(file.path);
        showToast(t("screenshot.copied"));
        await closeScreenshotOverlay();
      } catch (e) {
        showToast(t("screenshot.copyFailed", { error: formatUnknownError(e) }));
      }
    });

  const handleSave = () =>
    runBusy(async () => {
      try {
        const file = await saveDataUrl(await exportCropped());
        const { save } = await import("@tauri-apps/plugin-dialog");
        const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
        const dest = await save({
          title: t("screenshot.save"),
          defaultPath: `Taomni-${stamp}.png`,
          filters: [{ name: "PNG", extensions: ["png"] }],
        });
        if (typeof dest !== "string" || !dest.trim()) return;
        await saveImageToFile(file.path, dest);
        showToast(t("screenshot.saved"));
        await closeScreenshotOverlay();
      } catch (e) {
        showToast(t("screenshot.saveFailed", { error: formatUnknownError(e) }));
      }
    });

  const handlePin = () =>
    runBusy(async () => {
      try {
        const file = await saveDataUrl(await exportCropped());
        await pinToScreen(file.path);
        await closeScreenshotOverlay();
      } catch (e) {
        showToast(t("screenshot.pinFailed", { error: formatUnknownError(e) }));
      }
    });

  const handleOcr = () =>
    runBusy(async () => {
      setOcrLoading(true);
      setOcrOpen(true);
      setOcrText("");
      try {
        const file = await saveDataUrl(await exportCropped());
        const res = await ocrImage(file.path);
        setOcrText(res.text || t("screenshot.ocrEmpty"));
      } catch (e) {
        setOcrText(t("screenshot.ocrFailed", { error: formatUnknownError(e) }));
      } finally {
        setOcrLoading(false);
      }
    });

  /** Auto-redact e-mail / phone / ID tokens found by OCR. */
  const handleAutoRedact = () =>
    runBusy(async () => {
      try {
        const file = await saveDataUrl(await exportCropped());
        const res = await autoRedact(file.path);
        if (res.count === 0) {
          showToast(t("screenshot.redactNone"));
          return;
        }
        // Boxes are physical pixels of the exported (cropped) image.
        const ox = sel ? sel.x : 0;
        const oy = sel ? sel.y : 0;
        const shapes: Shape[] = res.boxes.map((b) => ({
          id: -1,
          kind: "mosaic" as const,
          color: "#000000",
          lineWidth: 2,
          x: ox + b.x / sx,
          y: oy + b.y / sy,
          w: b.w / sx,
          h: b.h / sy,
        }));
        canvasRef.current?.addShapes(shapes);
        showToast(t("screenshot.redacted", { count: res.count }));
      } catch (e) {
        showToast(t("screenshot.redactFailed", { error: formatUnknownError(e) }));
      }
    });

  const confirmScroll = async () => {
    if (!sel || !init) return;
    setScrollConfirm(true); setRecordOpen(false); setPlanningScroll(true); setPlannedRegion(null); setScrollError(null);
    try { setPlannedRegion(await scrollPlan(init.displayId || undefined, toPhysical(sel))); }
    catch (e) { setScrollError(formatUnknownError(e)); setScrollConfirm(false); }
    finally { setPlanningScroll(false); }
  };

  const handleScrollCapture = () =>
    runBusy(async () => {
      if (!init || !img || !sel || contour || !plannedRegion) return;
      setPhase("busy");
      setScrollError(null);
      setRecordOpen(false);
      setScrollConfirm(false);
      try {
        // The backend hides this window while it scrolls, then shows it.
        const res = await scrollCapture(init.displayId || undefined, plannedRegion, scrollMode);
        const loaded = await loadArtifact(res.path);
        await updateOverlayImage(res).catch(() => undefined);
        canvasRef.current?.clear();
        setInit({ ...init, path: res.path, width: res.width, height: res.height });
        setImg(loaded.img);
        setImgUrl(loaded.url);
        const size = { w: loaded.img.naturalWidth, h: loaded.img.naturalHeight };
        setScrollResult({ frames: res.frames, ...size });
        setSel({ x: 0, y: 0, ...size });
        setContour(null);
        setTool("move");
        setPhase("preview");
      } catch (e) {
        if (!String(e).includes("scroll capture cancelled")) setScrollError(formatUnknownError(e));
        setPhase("annotate");
      }
    });

  const handleRecord = (format: RecordFormat) =>
    runBusy(async () => {
      if (!init || !sel || contour) return;
      setScrollError(null);
      setRecordOpen(false);
      setPhase("busy");
      try {
        // The backend closes this overlay and opens the recorder bar.
        await startRecording(init.displayId || undefined, toPhysical(sel), format);
      } catch (e) {
        showToast(t("screenshot.recordFailed", { error: formatUnknownError(e) }));
        setPhase("annotate");
      }
    });

  // ---------------------------------------------------------------------
  // Keyboard
  // ---------------------------------------------------------------------

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target instanceof Element ? e.target : null;
      const typing = !!target?.closest("input, textarea, select, [contenteditable='true']");
      const mod = e.ctrlKey || e.metaKey;
      if (e.key === "Escape") {
        e.preventDefault();
        if (scrollError) close();
        else if (editOpen) setEditOpen(false);
        else if (scrollConfirm) setScrollConfirm(false);
        else if (recordOpen) setRecordOpen(false);
        else if (watermarkOpen) setWatermarkOpen(false);
        else if (ocrOpen) setOcrOpen(false);
        else if (pickerMode) exitPickerMode();
        else if (scrollResult) close();
        else if (phase === "annotate" && tool !== "select" && canvasRef.current?.shapeCount() === 0) setTool("select");
        else if (phase === "annotate") resetSelection();
        else close();
        return;
      }
      if (typing || editOpen || editBusy || (phase !== "annotate" && phase !== "preview")) return;
      if ((e.key === "Delete" || e.key === "Backspace") && tool === "move") {
        if (canvasRef.current?.deleteSelected()) e.preventDefault();
        return;
      }
      if (mod && e.key.toLowerCase() === "z") {
        e.preventDefault();
        if (e.shiftKey) canvasRef.current?.redo();
        else canvasRef.current?.undo();
      } else if (mod && e.key.toLowerCase() === "y") {
        e.preventDefault();
        canvasRef.current?.redo();
      } else if (mod && e.key.toLowerCase() === "c") {
        e.preventDefault();
        void handleCopy();
      } else if (mod && e.key.toLowerCase() === "s") {
        e.preventDefault();
        void handleSave();
      } else if (e.key === "Enter") {
        e.preventDefault();
        void handleCopy();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  });

  // ---------------------------------------------------------------------
  // Toolbar placement: below the selection, else above, else inside;
  // horizontally clamped to the viewport using its measured width.
  // ---------------------------------------------------------------------

  useLayoutEffect(() => {
    if (!sel || phase !== "annotate" || dragging) {
      setToolbarPos(null);
      return;
    }
    const el = toolbarRef.current;
    const w = el?.offsetWidth ?? 600;
    const h = el?.offsetHeight ?? 44;
    const gap = 8;
    let top: number;
    if (scrollResult) top = viewport.h - h - 12;
    else if (sel.y + sel.h + gap + h <= viewport.h - 4) top = sel.y + sel.h + gap;
    else if (sel.y - gap - h >= 4) top = sel.y - gap - h;
    else top = Math.max(8, viewport.h - h - 12);
    top = Math.min(Math.max(4, top), Math.max(4, viewport.h - h - 4));
    const left = Math.min(Math.max(4, sel.x + sel.w - w), Math.max(4, viewport.w - w - 4));
    setToolbarPos((prev) => (prev && prev.left === left && prev.top === top ? prev : { left, top }));
  }, [sel, phase, dragging, viewport.w, viewport.h, ocrOpen, tool, textSelected, scrollResult, moreOpen, fillableSelected]);

  useLayoutEffect(() => {
    if (!recordOpen) return;
    const button = recordButtonRef.current?.getBoundingClientRect();
    const menu = recordMenuRef.current;
    if (!button || !menu) return;
    const left = Math.max(8, Math.min(button.right - menu.offsetWidth, viewport.w - menu.offsetWidth - 8));
    const above = button.top - menu.offsetHeight - 8;
    const top = above >= 8 ? above : Math.max(8, Math.min(button.bottom + 8, viewport.h - menu.offsetHeight - 8));
    setRecordPos({ left, top });
  }, [recordOpen, toolbarPos, viewport]);

  useLayoutEffect(() => {
    if (!watermarkOpen) return;
    const button = watermarkButtonRef.current?.getBoundingClientRect();
    const panel = watermarkPanelRef.current;
    if (!button || !panel) return;
    const left = Math.max(8, Math.min(button.right - panel.offsetWidth, viewport.w - panel.offsetWidth - 8));
    const above = button.top - panel.offsetHeight - 8;
    const below = button.bottom + 8;
    const top = scrollResult && below + panel.offsetHeight <= viewport.h - 8
      ? below
      : above >= 8 ? above : Math.max(8, Math.min(below, viewport.h - panel.offsetHeight - 8));
    setWatermarkPos({ left, top });
  }, [watermarkOpen, toolbarPos, viewport, scrollResult, tool, textSelected]);

  useEffect(() => {
    if (!recordOpen) return;
    const onDown = (event: MouseEvent) => {
      if (!recordButtonRef.current?.contains(event.target as Node)) setRecordOpen(false);
    };
    window.addEventListener("mousedown", onDown);
    return () => window.removeEventListener("mousedown", onDown);
  }, [recordOpen]);

  if (loadError) {
    return (
      <div
        data-testid="screenshot-overlay"
        className="fixed inset-0 flex items-center justify-center"
        style={{ background: "#141414", color: "#ffffff" }}
      >
        <div className="text-center px-6 max-w-xl">
          <p data-testid="screenshot-overlay-error" className="mb-4 text-[14px] break-words">
            {t("screenshot.openFailed", { error: loadError })}
          </p>
          <button
            type="button"
            data-testid="screenshot-cancel"
            onClick={close}
            className="rounded-lg px-4 py-1.5 text-[13px]"
            style={{ background: "var(--taomni-accent)", color: "#ffffff" }}
          >
            {t("screenshot.cancel")}
          </button>
        </div>
      </div>
    );
  }

  const showHandles = phase === "annotate" && sel && tool === "select" && !pickerMode;
  const handles: { h: Handle; x: number; y: number }[] = sel
    ? [
        { h: "nw", x: sel.x, y: sel.y },
        { h: "n", x: sel.x + sel.w / 2, y: sel.y },
        { h: "ne", x: sel.x + sel.w, y: sel.y },
        { h: "e", x: sel.x + sel.w, y: sel.y + sel.h / 2 },
        { h: "se", x: sel.x + sel.w, y: sel.y + sel.h },
        { h: "s", x: sel.x + sel.w / 2, y: sel.y + sel.h },
        { h: "sw", x: sel.x, y: sel.y + sel.h },
        { h: "w", x: sel.x, y: sel.y + sel.h / 2 },
      ]
    : [];
  const physSel = sel ? toPhysical(sel) : null;
  const panelStyle: CSSProperties = {
    background: "var(--taomni-panel-bg)",
    border: "1px solid var(--taomni-divider)",
    color: "var(--taomni-text)",
  };

  const annotationLayer = img && (
    <AnnotationCanvas
      ref={canvasRef}
      imageWidth={imageSize.w}
      imageHeight={imageSize.h}
      tool={(phase === "annotate" || phase === "preview") && !pickerMode ? tool : "select"}
      color={color}
      lineWidth={lineWidth}
      fontFamily={fontFamily}
      fontSize={fontSize}
      fill={fill}
      eraserMode={eraserMode}
      onDrawingChange={setDrawing}
      textHint={t("screenshot.textHint")}
      baseImage={img}
      selection={sel}
      selectionContour={contour}
      onHistoryChange={(u, r) => {
        setCanUndo(u);
        setCanRedo(r);
      }}
      onSelectionChange={onAnnotationSelection}
      onRequestReselect={(p) => {
        resetSelection();
        startRegionDrag(p.x, p.y);
      }}
    />
  );

  const toolbar = (phase === "annotate" || phase === "preview") && sel && !dragging && (
    <div
      ref={toolbarRef}
      data-testid="screenshot-toolbar"
      data-drawing={drawing}
      className={scrollResult ? "relative z-50 shrink-0 px-4 py-2" : "fixed z-50"}
      style={scrollResult ? { ...panelStyle, maxHeight: "40vh", overflowY: "auto" } : {
        left: toolbarPos?.left ?? -9999,
        top: toolbarPos?.top ?? -9999,
        width: Math.min(760, viewport.w - 16),
        maxHeight: viewport.h - 16,
        overflowY: "auto",
        opacity: drawing ? 0.15 : 1,
        pointerEvents: drawing ? "none" : "auto",
      }}
      onMouseDown={(e) => e.stopPropagation()}
    >
      {(tool === "text" || textSelected) && <div data-testid="screenshot-text-style" className="flex flex-wrap items-center gap-2 rounded-xl px-3 py-2 mb-1 text-[12px]" style={panelStyle}>
        <label className="flex items-center gap-2">{t("screenshot.fontFamily")}
          <select data-testid="screenshot-font-family" aria-label={t("screenshot.fontFamily")} className="taomni-input h-7 max-w-44" value={fontFamily}
            onChange={(e) => { setFontFamily(e.target.value); if (textSelected) canvasRef.current?.updateSelectedStyle({ fontFamily: e.target.value }); }}>
            <option value={FONT_STACK}>{t("screenshot.fontDefault")}</option>
            <option value="serif">{t("screenshot.fontSerif")}</option>
            <option value="monospace">{t("screenshot.fontMono")}</option>
            {systemFonts.map((font) => <option key={font} value={`${JSON.stringify(font)}, sans-serif`}>{font}</option>)}
          </select>
        </label>
        <label className="flex items-center gap-2">{t("screenshot.fontSize")}
          <input data-testid="screenshot-font-size" aria-label={t("screenshot.fontSize")} type="number" min={8} max={144} step={1} value={fontSize}
            className="taomni-input h-7 w-16 px-2" onChange={(e) => { const value = e.target.valueAsNumber; if (Number.isFinite(value) && value >= 8 && value <= 144) { setFontSize(value); if (textSelected) canvasRef.current?.updateSelectedStyle({ fontSize: value }); } }} />
        </label>
        <span data-testid="screenshot-text-hint" className="text-[var(--taomni-text-muted)]">{t("screenshot.textHint")}</span>
      </div>}
      <div className="flex flex-wrap items-center gap-0.5 rounded-xl px-1.5 py-1 shadow-2xl" style={panelStyle}>
        {!scrollResult && <ToolButton testid="screenshot-selection-rectangle" title={t("screenshot.selectionRectangle")} active={selectionMode === "rectangle"} onClick={() => changeSelectionMode("rectangle")}>
          <Square size={16} />
        </ToolButton>}
        {!scrollResult && <ToolButton testid="screenshot-selection-freehand" title={t("screenshot.selectionFreehand")} active={selectionMode === "freehand"} onClick={() => changeSelectionMode("freehand")}>
          <Lasso size={16} />
        </ToolButton>}
        <div className="w-px h-5 mx-1" style={{ background: "var(--taomni-divider)" }} />
        {TOOLS.map(({ tool: name, testid, titleKey, Icon }) => (
          <ToolButton
            key={name}
            testid={testid}
            title={t(titleKey)}
            active={tool === name}
            onClick={() => {
              exitPickerMode();
              setTool((cur) => (cur === name ? "select" : name));
            }}
          >
            <Icon size={16} />
          </ToolButton>
        ))}
        {(FILLABLE_TOOLS.includes(tool) || fillableSelected) && <button type="button" data-testid="screenshot-fill" aria-pressed={fill}
          title={t("screenshot.solidFill")} className="rounded px-2 h-8 text-[12px]" onClick={() => { setFill(!fill); if (fillableSelected) canvasRef.current?.updateSelectedStyle({ filled: !fill }); }}>
          {t(fill ? "screenshot.solidFill" : "screenshot.outlineFill")}
        </button>}
        {tool === "eraser" && <select data-testid="screenshot-eraser-mode" aria-label={t("screenshot.toolEraser")} className="taomni-input h-8 text-[12px]" value={eraserMode} onChange={(e) => setEraserMode(e.target.value as EraserMode)}>
          <option value="partial">{t("screenshot.erasePartial")}</option><option value="object">{t("screenshot.eraseObject")}</option>
        </select>}
        <div className="basis-full h-px my-1" style={{ background: "var(--taomni-divider)" }} />
        {COLORS.map((c) => (
          <button
            key={c.value}
            type="button"
            data-testid={c.testid}
            title={t(c.titleKey)}
            aria-label={t(c.titleKey)}
            aria-pressed={color === c.value}
            onClick={() => { setColor(c.value); if (tool === "move") canvasRef.current?.updateSelectedStyle({ color: c.value }); }}
            className="w-5 h-5 mx-0.5 rounded-full shrink-0"
            style={{
              background: c.value,
              outline: color === c.value ? "2px solid var(--taomni-accent)" : "1px solid rgba(128, 128, 128, 0.45)",
              outlineOffset: 1,
            }}
          />
        ))}
        <input type="color" data-testid="screenshot-color-custom" aria-label={t("screenshot.colorCustom")} title={t("screenshot.colorCustom")}
          value={color} className="w-7 h-7 mx-1 shrink-0 cursor-pointer rounded border border-[var(--taomni-divider)] p-0.5"
          onChange={(e) => { setColor(e.target.value); if (tool === "move") canvasRef.current?.updateSelectedStyle({ color: e.target.value }); }} />
        <input type="text" data-testid="screenshot-color-hex" aria-label={t("screenshot.colorHex")} title={t("screenshot.colorHex")} value={colorDraft} maxLength={7}
          className="taomni-input h-7 w-20 px-1 text-[11px] font-mono" spellCheck={false}
          onChange={(e) => { const value = e.target.value; setColorDraft(value); if (/^#[0-9a-fA-F]{6}$/.test(value)) { setColor(value.toLowerCase()); if (tool === "move") canvasRef.current?.updateSelectedStyle({ color: value.toLowerCase() }); } }}
          onBlur={() => setColorDraft(color)} />
        {LINE_WIDTHS.map((w) => (
          <button
            key={w}
            type="button"
            data-testid={`screenshot-line-width-${w}`}
            title={`${w}px`}
            aria-label={`${w}px`}
            aria-pressed={lineWidth === w}
            onClick={() => { setLineWidth(w); if (tool === "move") canvasRef.current?.updateSelectedStyle({ lineWidth: w }); }}
            className="w-6 h-6 rounded-md flex items-center justify-center shrink-0"
            style={{ background: lineWidth === w ? "var(--taomni-hover)" : "transparent", color: "var(--taomni-text)" }}
          >
            <span className="rounded-full" style={{ width: w + 3, height: w + 3, background: "currentColor" }} />
          </button>
        ))}
        <div className="w-px h-5 mx-1" style={{ background: "var(--taomni-divider)" }} />
        <ToolButton testid="screenshot-undo" title={t("screenshot.undo")} disabled={!canUndo} onClick={() => canvasRef.current?.undo()}>
          <Undo2 size={16} />
        </ToolButton>
        <ToolButton testid="screenshot-redo" title={t("screenshot.redo")} disabled={!canRedo} onClick={() => canvasRef.current?.redo()}>
          <Redo2 size={16} />
        </ToolButton>
        <ToolButton testid="screenshot-annotation-delete" title={t("screenshot.deleteAnnotation")} disabled={!annotationSelected} onClick={() => { canvasRef.current?.deleteSelected(); }}>
          <Trash2 size={16} />
        </ToolButton>
        <div className="w-px h-5 mx-1" style={{ background: "var(--taomni-divider)" }} />
        {!scrollResult && <ToolButton testid="screenshot-scroll-capture" title={t(contour ? "screenshot.rectangleRequired" : "screenshot.scrollCapture")} disabled={!!contour || !!scrollResult} onClick={() => void confirmScroll()}>
          <ScrollText size={16} />
        </ToolButton>}
        {!scrollResult && <ToolButton testid="screenshot-recrop" title={t("screenshot.recrop")} active={tool === "select"} onClick={() => setTool("select")}><Crop size={16} /></ToolButton>}
        <ToolButton testid="screenshot-pin" title={t("screenshot.pinDescription")} onClick={() => void handlePin()}><Pin size={16} /></ToolButton>
        <ToolButton testid="screenshot-edit" title={t("screenshot.editImage")} onClick={() => setEditOpen(true)}><SlidersHorizontal size={16} /></ToolButton>
        <ToolButton testid="screenshot-more" title={t("screenshot.moreTools")} active={moreOpen} onClick={() => setMoreOpen(!moreOpen)}><MoreHorizontal size={16} /></ToolButton>
        <div data-testid="screenshot-more-tools" className="flex flex-wrap items-center gap-0.5 basis-full" style={{ display: moreOpen ? "flex" : "none" }}>
        <ToolButton
          testid="screenshot-color-picker"
          title={t("screenshot.colorPicker")}
          active={pickerMode}
          onClick={() => (pickerMode ? exitPickerMode() : enterPickerMode())}
        >
          <Pipette size={16} />
        </ToolButton>
        <ToolButton testid="screenshot-ocr" title={t("screenshot.ocr")} onClick={() => void handleOcr()}>
          <ScanText size={16} />
        </ToolButton>
        <ToolButton testid="screenshot-auto-redact" title={t("screenshot.autoRedact")} onClick={() => void handleAutoRedact()}>
          <ShieldAlert size={16} />
        </ToolButton>
        <div ref={watermarkButtonRef} className="relative">
          <ToolButton
            testid="screenshot-watermark"
            title={t("screenshot.watermark")}
            active={watermarkOpen || watermark !== null}
            onClick={() => {
              setRecordOpen(false);
              setWatermarkOpen((v) => !v);
            }}
          >
            <Stamp size={16} />
          </ToolButton>
          {watermarkOpen && (
            <div
              ref={watermarkPanelRef}
              data-testid="screenshot-watermark-panel"
              className="fixed rounded-lg shadow-2xl p-3 overflow-y-auto"
              style={{ zIndex: 65, width: Math.min(224, viewport.w - 16), maxHeight: viewport.h - 16, ...watermarkPos, ...panelStyle }}
            >
              <input
                type="text"
                data-testid="screenshot-watermark-text"
                value={watermarkText}
                maxLength={120}
                onChange={(e) => setWatermarkText(e.target.value)}
                placeholder={t("screenshot.watermarkPlaceholder")}
                aria-label={t("screenshot.watermarkPlaceholder")}
                className="taomni-input w-full h-7 px-2 text-[13px] mb-2"
              />
              <label className="flex items-center gap-2 text-[12px] mb-2">
                <span className="shrink-0">{t("screenshot.watermarkOpacity")}</span>
                <input
                  type="range"
                  data-testid="screenshot-watermark-opacity"
                  min={10}
                  max={80}
                  value={Math.round(watermarkOpacity * 100)}
                  onChange={(e) => setWatermarkOpacity(Number(e.target.value) / 100)}
                  className="min-w-0 flex-1"
                />
                <span className="w-8 text-right font-mono">{Math.round(watermarkOpacity * 100)}%</span>
              </label>
              <div className="flex items-center gap-1.5 mb-3">
                {["#ffffff", "#000000", "#ff4444", "#ffcc00", "#00aaff"].map((c) => (
                  <button
                    key={c}
                    type="button"
                    data-testid={`screenshot-watermark-color-${c.slice(1)}`}
                    aria-label={c}
                    onClick={() => setWatermarkColor(c)}
                    className="w-5 h-5 rounded-full shrink-0"
                    style={{
                      background: c,
                      outline: watermarkColor === c ? "2px solid var(--taomni-accent)" : "1px solid rgba(128,128,128,0.45)",
                      outlineOffset: 1,
                    }}
                  />
                ))}
              </div>
              <div className="flex gap-2">
                <button
                  type="button"
                  data-testid="screenshot-watermark-apply"
                  onClick={() => {
                    if (watermarkText.trim()) {
                      setWatermark({ text: watermarkText.trim(), opacity: watermarkOpacity, color: watermarkColor, seed: watermark?.seed ?? crypto.getRandomValues(new Uint32Array(1))[0] });
                    }
                    setWatermarkOpen(false);
                  }}
                  className="flex-1 rounded px-2 py-1 text-[13px]"
                  style={{ background: "var(--taomni-accent)", color: "#ffffff" }}
                >
                  {t("screenshot.watermarkApply")}
                </button>
                <button
                  type="button"
                  data-testid="screenshot-watermark-clear"
                  onClick={() => {
                    setWatermark(null);
                    setWatermarkText("");
                    setWatermarkOpen(false);
                  }}
                  className="rounded px-2 py-1 text-[13px]"
                  style={{ border: "1px solid var(--taomni-divider)" }}
                >
                  {t("screenshot.watermarkClear")}
                </button>
              </div>
            </div>
          )}
        </div>
        {!scrollResult && <div ref={recordButtonRef} className="relative">
          <ToolButton
            testid="screenshot-record"
            title={t(contour ? "screenshot.rectangleRequired" : "screenshot.record")}
            disabled={!!contour || !!scrollResult}
            active={recordOpen}
            onClick={() => {
              setWatermarkOpen(false);
              setRecordOpen((v) => !v);
            }}
          >
            <span className="flex items-center">
              <Video size={16} />
              <ChevronDown size={12} />
            </span>
          </ToolButton>
          {recordOpen && (
            <div
              ref={recordMenuRef}
              data-testid="screenshot-record-menu"
              className="fixed rounded-xl p-2 shadow-2xl text-[13px] overflow-y-auto"
              style={{ zIndex: 65, width: Math.min(320, viewport.w - 16), maxHeight: viewport.h - 16, ...recordPos, ...panelStyle }}
            >
              <p data-testid="screenshot-record-hint" className="px-2 py-2 leading-relaxed whitespace-normal break-words text-[var(--taomni-text-muted)]">{t("screenshot.recordHint", { shortcut: stopShortcut || t("settings.screenshotDisabled") })}</p>
              <button
                type="button"
                data-testid="screenshot-record-gif"
                onClick={() => void handleRecord("gif")}
                className="block w-full text-left px-4 py-1.5 hover:bg-[var(--taomni-hover)]"
              >
                {t("screenshot.recordGif")}
              </button>
              <button
                type="button"
                data-testid="screenshot-record-mp4"
                onClick={() => void handleRecord("mp4")}
                className="block w-full text-left px-4 py-1.5 hover:bg-[var(--taomni-hover)]"
              >
                {t("screenshot.recordMp4")}
              </button>
            </div>
          )}
        </div>}
        </div>
        <div className="w-px h-5 mx-1" style={{ background: "var(--taomni-divider)" }} />
        {!scrollResult && <><ToolButton testid="screenshot-cancel" title={`${t("screenshot.cancel")} (Esc)`} onClick={close}>
          <X size={16} />
        </ToolButton>
        <ToolButton testid="screenshot-save" title={`${t("screenshot.save")} (Ctrl+S)`} onClick={() => void handleSave()}>
          <Download size={16} />
        </ToolButton>
        <button
          type="button"
          data-testid="screenshot-copy"
          title={`${t("screenshot.copy")} (Enter / Ctrl+C)`}
          onClick={() => void handleCopy()}
          className="ml-1 h-8 shrink-0 rounded-lg px-3 flex items-center gap-1 text-[13px] font-medium"
          style={{ background: "var(--taomni-accent)", color: "#ffffff" }}
        >
          <Check size={15} />
          {t("screenshot.done")}
        </button></>}
      </div>
    </div>
  );

  return (
    <div
      data-testid="screenshot-overlay"
      data-phase={phase}
      data-selection-mode={selectionMode}
      className="fixed inset-0 overflow-hidden select-none"
      style={{ background: "#000000" }}
    >
      {!scrollResult && img && imgUrl && (
        <img
          data-testid="screenshot-base-image"
          src={imgUrl}
          alt=""
          draggable={false}
          className="fixed inset-0 z-0"
          style={{ width: imageSize.w, height: imageSize.h }}
        />
      )}

      {/* Dim layer: full dim while selecting, selection-hole dim once selected. */}
      {!sel && (
        <div className="fixed inset-0 z-10 pointer-events-none" style={{ background: "rgba(0, 0, 0, 0.4)" }} />
      )}
      {contour && (
        <svg className="fixed inset-0 z-[35] pointer-events-none" width={viewport.w} height={viewport.h}>
          <path
            d={`M 0 0 H ${viewport.w} V ${viewport.h} H 0 Z ${contourPath(contour)}`}
            fill="rgba(0,0,0,0.45)" fillRule="evenodd"
          />
          <path data-testid="screenshot-freehand-contour" d={contourPath(contour)} fill="none" stroke="#1677ff" strokeWidth={1} />
        </svg>
      )}
      {sel && phase !== "preview" && (
        <div
          data-testid="screenshot-selection"
          className="fixed z-[35] pointer-events-none"
          style={{
            left: sel.x,
            top: sel.y,
            width: Math.max(0, sel.w),
            height: Math.max(0, sel.h),
            outline: contour ? undefined : "1px solid #1677ff",
            border: contour ? "1px dashed rgba(22,119,255,0.55)" : undefined,
            boxShadow: contour ? undefined : "0 0 0 9999px rgba(0, 0, 0, 0.45)",
          }}
        />
      )}

      {/* Region selection / outside-press layer. */}
      {!scrollResult && <div
        data-testid="screenshot-select-layer"
        className="fixed inset-0 z-20"
        style={{ cursor: phase === "select" ? "crosshair" : "default" }}
        onMouseDown={handleSelectMouseDown}
        onDoubleClick={handleDoubleClick}
      />}

      {/* Move area + resize handles (no draw tool active). */}
      {showHandles && sel && (
        <>
          <div
            data-testid="screenshot-selection-move"
            className="fixed z-[36]"
            style={{
              left: sel.x, top: sel.y, width: sel.w, height: sel.h, cursor: "move",
              clipPath: contour ? `polygon(evenodd, ${contour.map((p) => `${p.x - sel.x}px ${p.y - sel.y}px`).join(", ")})` : undefined,
            }}
            onMouseDown={(e) => startHandleDrag(e, "move")}
            onDoubleClick={handleDoubleClick}
          />
          {handles.map(({ h, x, y }) => (
            <div
              key={h}
              data-testid={`screenshot-handle-${h}`}
              className="fixed z-[37] rounded-sm"
              style={{
                left: x - HANDLE / 2,
                top: y - HANDLE / 2,
                width: HANDLE,
                height: HANDLE,
                background: "#1677ff",
                border: "1px solid #fff",
                cursor: HANDLE_CURSORS[h],
              }}
              onMouseDown={(e) => startHandleDrag(e, h)}
            />
          ))}
        </>
      )}

      {!scrollResult && annotationLayer}

      {/* Magnifier while choosing a region. */}
      {phase === "select" && img && cursor && (
        <Magnifier img={img} cursor={cursor} sx={sx} sy={sy} viewport={viewport} />
      )}

      {/* Size label at the selection's top-left. */}
      {sel && physSel && sel.w > 0 && sel.h > 0 && (phase === "select" || phase === "annotate") && (
        <div
          data-testid="screenshot-size-hint"
          style={{
            position: "fixed",
            zIndex: 60,
            left: sel.x,
            top: sel.y >= 26 ? sel.y - 24 : sel.y + 4,
            pointerEvents: "none",
            background: "rgba(0, 0, 0, 0.75)",
            color: "#ffffff",
            fontSize: 12,
            padding: "2px 6px",
            borderRadius: 4,
            whiteSpace: "nowrap",
          }}
        >
          {`${physSel.width} × ${physSel.height}`}
        </div>
      )}

      {!scrollResult && toolbar}

      {phase === "preview" && scrollResult && img && imgUrl && <ScrollCaptureResult url={imgUrl} width={img.naturalWidth} height={img.naturalHeight}
        frames={scrollResult.frames} toolbar={toolbar} onCopy={() => void handleCopy()} onSave={() => void handleSave()}
        onPin={() => void handlePin()} onClose={close}>{annotationLayer}</ScrollCaptureResult>}

      {/* Busy state (scroll capture / recording start). */}
      {scrollConfirm && <div data-testid="screenshot-scroll-confirm" role="dialog" aria-label={t("screenshot.scrollCapture")}
        className="fixed inset-0 flex items-center justify-center" style={{ zIndex: 80, background: "rgba(0,0,0,0.25)" }}>
        <div className="rounded-xl shadow-2xl p-5 w-96 text-[13px]" style={panelStyle}>
          <p className="font-medium mb-2">{t("screenshot.scrollCapture")}</p>
          <fieldset className="flex gap-4 mb-3">
            <legend className="sr-only">{t("screenshot.scrollMode")}</legend>
            {(["auto", "manual"] as const).map((mode) => <label key={mode} className="flex items-center gap-2 cursor-pointer">
              <input type="radio" name="scroll-mode" data-testid={`screenshot-scroll-mode-${mode}`} checked={scrollMode === mode} onChange={() => setScrollMode(mode)} />
              {t(mode === "auto" ? "screenshot.scrollAuto" : "screenshot.scrollManual")}
            </label>)}
          </fieldset>
          <p data-testid="screenshot-scroll-mode-description" className="mb-3">{t(scrollMode === "auto" ? "screenshot.scrollRunningHint" : "screenshot.scrollManualHint")}</p>
          {plannedRegion && physSel && plannedRegion.height !== physSel.height && <p data-testid="screenshot-scroll-adjusted" className="mb-3 text-amber-600">{t("screenshot.scrollAdjusted", { width: plannedRegion.width, height: plannedRegion.height })}</p>}
          <p data-testid="screenshot-scroll-instructions" className="mb-4">{t("screenshot.scrollInstructions")}</p>
          <div className="flex justify-end gap-2">
            <button data-testid="screenshot-scroll-confirm-cancel" type="button" className="px-3 py-2 rounded-lg" onClick={() => setScrollConfirm(false)}>{t("screenshot.cancel")}</button>
            <button data-testid="screenshot-scroll-start" disabled={planningScroll || !plannedRegion} type="button" className="px-3 py-2 rounded-lg" style={{ background: "var(--taomni-accent)", color: "#fff" }} onClick={() => void handleScrollCapture()}>{t("screenshot.scrollStart")}</button>
          </div>
        </div>
      </div>}
      {phase === "busy" && (
        <div
          data-testid="screenshot-scroll-busy"
          className="fixed left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 rounded-xl px-5 py-3 text-[13px] shadow-2xl"
          style={{ zIndex: 60, ...panelStyle }}
        >
          {t("screenshot.scrollCapturing")}
        </div>
      )}

      {/* Bottom hint bar while selecting. */}
      {phase === "select" && !dragging && (
        <div
          className="fixed left-1/2 -translate-x-1/2 bottom-8 flex items-center gap-3 rounded-full px-4 py-2 shadow-2xl text-[13px]"
          style={{ zIndex: 50, ...panelStyle }}
        >
          <span data-testid="screenshot-hint">{t(selectionMode === "freehand" ? "screenshot.freehandHint" : "screenshot.selectHint")}</span>
          <ToolButton testid="screenshot-selection-rectangle" title={t("screenshot.selectionRectangle")} active={selectionMode === "rectangle"} onClick={() => changeSelectionMode("rectangle")}>
            <Square size={16} />
          </ToolButton>
          <ToolButton testid="screenshot-selection-freehand" title={t("screenshot.selectionFreehand")} active={selectionMode === "freehand"} onClick={() => changeSelectionMode("freehand")}>
            <Lasso size={16} />
          </ToolButton>
          <button
            type="button"
            data-testid="screenshot-fullscreen"
            onClick={fullscreenSelect}
            className="flex items-center gap-1 rounded-full px-2.5 py-0.5 text-[12px]"
            style={{ background: "var(--taomni-accent)", color: "#ffffff" }}
          >
            <Maximize size={13} />
            {t("screenshot.fullscreen")}
          </button>
        </div>
      )}

      {editOpen && img && <ImageEditPanel key={`${img.naturalWidth}x${img.naturalHeight}:${imageUndo.length}:${imageRedo.length}`}
        width={physSel?.width ?? img.naturalWidth} height={physSel?.height ?? img.naturalHeight} busy={editBusy}
        canUndo={imageUndo.length > 0} canRedo={imageRedo.length > 0} onApply={(edit) => void editImage(edit)}
        onUndo={undoImage} onRedo={redoImage} onExternal={(choose) => void externalEdit(choose)} onClose={() => setEditOpen(false)} />}

      {/* Color picker layer (above the canvas, below the toolbar). */}
      {pickerMode && (
        <div
          data-testid="screenshot-picker-layer"
          className="fixed inset-0"
          style={{ zIndex: scrollResult ? 85 : 40, cursor: "crosshair" }}
          onMouseMove={handlePickerMove}
          onMouseLeave={() => setPickerInfo(null)}
          onClick={() => void handlePickerPick()}
        />
      )}
      {pickerMode && pickerInfo && (
        <div
          data-testid="screenshot-picker-popup"
          className="fixed pointer-events-none flex items-center gap-2 rounded-lg px-2.5 py-1.5 shadow-2xl"
          style={{
            zIndex: scrollResult ? 86 : 45,
            left: Math.min(pickerInfo.x + 18, viewport.w - 200),
            top: Math.min(pickerInfo.y + 18, viewport.h - 60),
            background: "rgba(20, 20, 20, 0.92)",
            color: "#ffffff",
            fontSize: 12,
          }}
        >
          <span className="w-6 h-6 rounded shrink-0" style={{ background: pickerInfo.hex, border: "1px solid rgba(255,255,255,0.4)" }} />
          <span data-testid="screenshot-picker-hex" className="font-mono whitespace-nowrap">
            {pickerInfo.hex}
          </span>
          <span className="opacity-70 font-mono whitespace-nowrap">{pickerInfo.rgb}</span>
        </div>
      )}

      {/* OCR result panel. */}
      {ocrOpen && (
        <div
          data-testid="screenshot-ocr-panel"
          className="fixed rounded-xl shadow-2xl p-4 w-80"
          style={{ zIndex: 80, right: 16, top: 16, ...panelStyle }}
          onMouseDown={(e) => e.stopPropagation()}
        >
          <div className="flex items-center justify-between mb-2">
            <span className="text-[13px] font-medium">{t("screenshot.ocrTitle")}</span>
            <button
              type="button"
              data-testid="screenshot-ocr-close"
              aria-label={t("screenshot.cancel")}
              onClick={() => setOcrOpen(false)}
              className="rounded p-1 hover:bg-[var(--taomni-hover)]"
            >
              <X size={14} />
            </button>
          </div>
          {ocrLoading ? (
            <div className="text-[13px] opacity-70 py-4 text-center">{t("screenshot.ocrLoading")}</div>
          ) : (
            <>
              <textarea
                data-testid="screenshot-ocr-text"
                readOnly
                value={ocrText}
                rows={8}
                aria-label={t("screenshot.ocrTitle")}
                className="taomni-input w-full px-2 py-1.5 text-[13px] font-mono resize-y mb-2"
              />
              <button
                type="button"
                data-testid="screenshot-ocr-copy"
                onClick={() => {
                  import("../../lib/clipboard")
                    .then(({ writeText }) => writeText(ocrText))
                    .then(() => showToast(t("screenshot.ocrCopied")))
                    .catch(() => showToast(t("screenshot.ocrCopyFailed")));
                }}
                className="w-full rounded px-2 py-1.5 text-[13px]"
                style={{ background: "var(--taomni-accent)", color: "#ffffff" }}
              >
                {t("screenshot.ocrCopy")}
              </button>
            </>
          )}
        </div>
      )}

      {scrollError && (
        <div
          data-testid="screenshot-scroll-error"
          role="alert"
          className="fixed left-1/2 -translate-x-1/2 bottom-20 w-[min(640px,90vw)] rounded-lg px-4 py-3 text-[13px] shadow-2xl"
          style={{ zIndex: 70, ...panelStyle }}
        >
          <p className="break-words">{t("screenshot.scrollFailed", { error: scrollError })}</p>
          <button type="button" data-testid="screenshot-scroll-error-close" className="mt-2 rounded px-3 py-2" onClick={close}>
            {t("screenshot.cancel")} (Esc)
          </button>
        </div>
      )}

      {/* Toast. */}
      {toast && (
        <div
          data-testid="screenshot-toast"
          role="status"
          className="fixed left-1/2 -translate-x-1/2 bottom-20 rounded-full px-4 py-2 text-[13px] shadow-2xl"
          style={{ zIndex: 90, background: "rgba(20, 20, 20, 0.92)", color: "#ffffff" }}
        >
          {toast}
        </div>
      )}
    </div>
  );
}
