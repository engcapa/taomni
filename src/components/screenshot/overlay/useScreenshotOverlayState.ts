import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { formatUnknownError } from "../../../lib/appDialogs";
import { useT } from "../../../lib/i18n";
import { listSystemFonts } from "../../../lib/ipc";
import {
  captureFull,
  closeScreenshotOverlay,
  fetchOverlayInit,
  listDisplays,
  revokeScreenshotUrl,
  toPhysicalRect,
  type OverlayInit,
  type PhysicalRect,
  type ScreenshotDisplay,
  type ScreenshotPoint,
  type ScrollMode,
} from "../../../lib/screenshot";
import { type WatermarkSettings } from "../../../lib/screenshotImage";
import { screenshotShortcutLabel, useScreenshotShortcutStore } from "../../../lib/screenshotShortcut";
import { FILLABLE_TOOLS, FONT_STACK, type AnnotationCanvasHandle, type AnnotationTool, type CssRect, type EraserMode, type Shape } from "../AnnotationCanvas";
import { loadArtifact } from "./images";
import { COLORS } from "./tools";
import { type Handle, type ImageSnapshot, type Phase } from "./types";


export function useScreenshotOverlayState() {
  const t = useT();
  const stopShortcut = screenshotShortcutLabel(useScreenshotShortcutStore((s) => s.status));
  const [init, setInit] = useState<OverlayInit | null>(null);
  const [displays, setDisplays] = useState<ScreenshotDisplay[]>([]);
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
  const [scrollResult, setScrollResult] = useState<{ frames: number; w: number; h: number; } | null>(null);
  const [pinDoneOpen, setPinDoneOpen] = useState(false);
  const [busy, setBusy] = useState(false);
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
  const [cursor, setCursor] = useState<{ x: number; y: number; } | null>(null);
  const [dragging, setDragging] = useState(false);
  const [recordOpen, setRecordOpen] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [scrollError, setScrollError] = useState<string | null>(null);
  const [viewport, setViewport] = useState({ w: window.innerWidth, h: window.innerHeight });
  const [pickerMode, setPickerMode] = useState(false);
  const [pickerInfo, setPickerInfo] = useState<{ x: number; y: number; hex: string; rgb: string; } | null>(null);
  const pickerCacheRef = useRef<ImageData | null>(null);
  const [watermarkOpen, setWatermarkOpen] = useState(false);
  const [watermark, setWatermark] = useState<WatermarkSettings | null>(null);
  const [watermarkText, setWatermarkText] = useState("");
  const [watermarkOpacity, setWatermarkOpacity] = useState(0.16);
  const [watermarkColor, setWatermarkColor] = useState("#ffffff");
  const [ocrOpen, setOcrOpen] = useState(false);
  const [ocrText, setOcrText] = useState("");
  const [ocrLoading, setOcrLoading] = useState(false);
  const [toolbarPos, setToolbarPos] = useState<{ left: number; top: number; } | null>(null);
  const canvasRef = useRef<AnnotationCanvasHandle | null>(null);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const pendingShapes = useRef<Shape[] | null>(null);
  // The backend focuses the native window once it is mapped; give the document
  // focus too, so key handlers run even when the window is focused without a
  // focused element (otherwise the first click has to do it).
  useEffect(() => {
    window.focus();
    rootRef.current?.focus({ preventScroll: true });
  }, []);
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
      if (!data.document) void listDisplays().then((items) => { if (!cancelled) setDisplays(items); }).catch(() => undefined);
      setImg(loaded.img);
      setImgUrl(loaded.url);
      if (data.document) {
        const size = { w: loaded.img.naturalWidth, h: loaded.img.naturalHeight };
        setScrollResult({ frames: 0, ...size }); setSel({ x: 0, y: 0, ...size }); setTool("move"); setPhase("preview");
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
  return {
    img,
    pickerCacheRef,
    setPickerInfo,
    setPickerMode,
    showToast,
    t,
    scrollResult,
    sx,
    sy,
    pickerInfo,
    setSel,
    imageSize,
    setContour,
    setSelectionMode,
    setTool,
    setPhase,
    setScrollError,
    canvasRef,
    dragRef,
    setDragging,
    setRecordOpen,
    setWatermarkOpen,
    selectionMode,
    sel,
    contour,
    phase,
    setCursor,
    viewport,
    tool,
    toPhysical,
    watermark,
    busyRef,
    setBusy,
    imgUrl,
    setImg,
    setImgUrl,
    setScrollResult,
    pendingShapes,
    imageUndo,
    editBusy,
    setImageRedo,
    setImageUndo,
    imageRedo,
    setEditBusy,
    setInit,
    init,
    setPinDoneOpen,
    setOcrLoading,
    setOcrOpen,
    setOcrText,
    setScrollConfirm,
    setPlanningScroll,
    setPlannedRegion,
    plannedRegion,
    scrollMode,
    pinDoneOpen,
    scrollError,
    close,
    editOpen,
    setEditOpen,
    scrollConfirm,
    recordOpen,
    watermarkOpen,
    ocrOpen,
    pickerMode,
    dragging,
    setToolbarPos,
    toolbarRef,
    textSelected,
    moreOpen,
    fillableSelected,
    recordButtonRef,
    recordMenuRef,
    setRecordPos,
    toolbarPos,
    watermarkButtonRef,
    watermarkPanelRef,
    setWatermarkPos,
    loadError,
    color,
    lineWidth,
    fontFamily,
    fontSize,
    fill,
    eraserMode,
    setDrawing,
    setCanUndo,
    setCanRedo,
    onAnnotationSelection,
    drawing,
    setFontFamily,
    systemFonts,
    setFontSize,
    setFill,
    setEraserMode,
    setColor,
    colorDraft,
    setColorDraft,
    setLineWidth,
    canUndo,
    canRedo,
    annotationSelected,
    setMoreOpen,
    watermarkPos,
    watermarkText,
    setWatermarkText,
    watermarkOpacity,
    setWatermarkOpacity,
    setWatermarkColor,
    watermarkColor,
    setWatermark,
    recordPos,
    stopShortcut,
    rootRef,
    cursor,
    displays,
    busy,
    setScrollMode,
    planningScroll,
    ocrLoading,
    ocrText,
    toast,
  };
}
