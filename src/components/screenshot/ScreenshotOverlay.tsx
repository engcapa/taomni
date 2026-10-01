import { useCallback, useEffect, useRef, useState } from "react";
import type { CSSProperties, MouseEvent as ReactMouseEvent, ReactNode } from "react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import {
  ArrowUpRight,
  ChevronDown,
  Circle,
  Clipboard,
  Download,
  LayoutGrid,
  ListOrdered,
  Maximize,
  Minus,
  Pencil,
  Redo2,
  ScrollText,
  Square,
  Type,
  Undo2,
  Video,
  X,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";
import { useT } from "../../lib/i18n";
import {
  captureFull,
  closeScreenshotOverlay,
  copyImageToClipboard,
  fetchOverlayInit,
  saveDataUrl,
  saveImageToFile,
  scrollCapture,
  screenshotFileUrl,
  startRecording,
  normalizeRect,
  toPhysicalRect,
  type OverlayInit,
  type RecordFormat,
} from "../../lib/screenshot";
import {
  AnnotationCanvas,
  type AnnotationCanvasHandle,
  type AnnotationTool,
  type CssRect,
} from "./AnnotationCanvas";

type Phase = "loading" | "select" | "annotate" | "busy";

const MIN_SEL = 6;

const COLORS: { value: string; testid: string; titleKey: string }[] = [
  { value: "#ff4d4f", testid: "screenshot-color-red", titleKey: "screenshot.colorRed" },
  { value: "#faad14", testid: "screenshot-color-yellow", titleKey: "screenshot.colorYellow" },
  { value: "#52c41a", testid: "screenshot-color-green", titleKey: "screenshot.colorGreen" },
  { value: "#1677ff", testid: "screenshot-color-blue", titleKey: "screenshot.colorBlue" },
  { value: "#ffffff", testid: "screenshot-color-white", titleKey: "screenshot.colorWhite" },
];

const TOOLS: { tool: AnnotationTool; testid: string; titleKey: string; Icon: LucideIcon }[] = [
  { tool: "rect", testid: "screenshot-tool-rect", titleKey: "screenshot.toolRect", Icon: Square },
  { tool: "ellipse", testid: "screenshot-tool-ellipse", titleKey: "screenshot.toolEllipse", Icon: Circle },
  { tool: "arrow", testid: "screenshot-tool-arrow", titleKey: "screenshot.toolArrow", Icon: ArrowUpRight },
  { tool: "line", testid: "screenshot-tool-line", titleKey: "screenshot.toolLine", Icon: Minus },
  { tool: "pen", testid: "screenshot-tool-pen", titleKey: "screenshot.toolPen", Icon: Pencil },
  { tool: "text", testid: "screenshot-tool-text", titleKey: "screenshot.toolText", Icon: Type },
  { tool: "mosaic", testid: "screenshot-tool-mosaic", titleKey: "screenshot.toolMosaic", Icon: LayoutGrid },
  { tool: "number", testid: "screenshot-tool-number", titleKey: "screenshot.toolNumber", Icon: ListOrdered },
];

const LINE_WIDTHS = [2, 4, 8];

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("failed to load screenshot image"));
    image.src = src;
  });
}

/** Crop a PNG data URL to a device-pixel rect. */
function cropDataUrl(
  dataUrl: string,
  r: { x: number; y: number; w: number; h: number },
): Promise<string> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => {
      const c = document.createElement("canvas");
      c.width = Math.max(1, Math.round(r.w));
      c.height = Math.max(1, Math.round(r.h));
      const ctx = c.getContext("2d");
      if (!ctx) {
        reject(new Error("canvas 2d context unavailable"));
        return;
      }
      ctx.drawImage(image, r.x, r.y, r.w, r.h, 0, 0, c.width, c.height);
      resolve(c.toDataURL("image/png"));
    };
    image.onerror = () => reject(new Error("failed to crop screenshot"));
    image.src = dataUrl;
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
      disabled={disabled}
      onClick={onClick}
      className="w-8 h-8 rounded-lg flex items-center justify-center transition-colors disabled:opacity-40"
      style={{
        background: active ? "var(--taomni-accent)" : "transparent",
        color: active ? "#ffffff" : "var(--taomni-text)",
      }}
      onMouseEnter={(e) => {
        if (!active) e.currentTarget.style.background = "var(--taomni-hover)";
      }}
      onMouseLeave={(e) => {
        if (!active) e.currentTarget.style.background = "transparent";
      }}
    >
      {children}
    </button>
  );
}

/** Feishu-style magnifier: 120px box, 3x zoom, crosshair. */
function Magnifier({
  img,
  cursor,
  scale,
}: {
  img: HTMLImageElement;
  cursor: { x: number; y: number };
  scale: number;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const size = 120;
    const zoom = 3;
    canvas.width = size;
    canvas.height = size;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    const srcCss = size / zoom;
    const cx = cursor.x * scale;
    const cy = cursor.y * scale;
    const half = (srcCss * scale) / 2;
    ctx.imageSmoothingEnabled = false;
    ctx.clearRect(0, 0, size, size);
    ctx.drawImage(img, cx - half, cy - half, half * 2, half * 2, 0, 0, size, size);
    ctx.strokeStyle = "rgba(22, 119, 255, 0.9)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(size / 2 + 0.5, 0);
    ctx.lineTo(size / 2 + 0.5, size);
    ctx.moveTo(0, size / 2 + 0.5);
    ctx.lineTo(size, size / 2 + 0.5);
    ctx.stroke();
  }, [img, cursor, scale]);

  const size = 120;
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  let left = cursor.x + 18;
  let top = cursor.y + 18;
  if (cursor.x > vw - size - 24) left = cursor.x - size - 18;
  if (cursor.y > vh - size - 24) top = cursor.y - size - 18;

  return (
    <div
      data-testid="screenshot-magnifier"
      style={{
        position: "fixed",
        zIndex: 60,
        left,
        top,
        width: size,
        height: size,
        pointerEvents: "none",
        borderRadius: 8,
        overflow: "hidden",
        border: "1px solid rgba(255, 255, 255, 0.65)",
        boxShadow: "0 4px 18px rgba(0, 0, 0, 0.55)",
        background: "#000",
      }}
    >
      <canvas ref={canvasRef} style={{ display: "block", width: size, height: size }} />
    </div>
  );
}

export function ScreenshotOverlay() {
  const t = useT();
  const [init, setInit] = useState<OverlayInit | null>(null);
  const [img, setImg] = useState<HTMLImageElement | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [phase, setPhase] = useState<Phase>("loading");
  const [sel, setSel] = useState<CssRect | null>(null);
  const [tool, setTool] = useState<AnnotationTool>("select");
  const [color, setColor] = useState(COLORS[3].value);
  const [lineWidth, setLineWidth] = useState(3);
  const [canUndo, setCanUndo] = useState(false);
  const [canRedo, setCanRedo] = useState(false);
  const [cursor, setCursor] = useState<{ x: number; y: number } | null>(null);
  const [recordOpen, setRecordOpen] = useState(false);
  const [toast, setToast] = useState<string | null>(null);
  const [viewport, setViewport] = useState({ w: window.innerWidth, h: window.innerHeight });
  const canvasRef = useRef<AnnotationCanvasHandle | null>(null);
  const dragRef = useRef<{ start: { x: number; y: number } } | null>(null);
  const toastTimer = useRef<number | null>(null);

  /** CSS px -> physical px (backend image is physical pixels). */
  const scale = img ? img.naturalWidth / viewport.w : 1;
  const bgUrl = init ? screenshotFileUrl(init.path) : "";

  const showToast = useCallback((msg: string) => {
    setToast(msg);
    if (toastTimer.current) window.clearTimeout(toastTimer.current);
    toastTimer.current = window.setTimeout(() => setToast(null), 2500);
  }, []);

  useEffect(() => {
    return () => {
      if (toastTimer.current) window.clearTimeout(toastTimer.current);
    };
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
        data = { path: file.path, displayId: null, width: file.width, height: file.height };
      }
      if (cancelled) return;
      setInit(data);
      const image = await loadImage(screenshotFileUrl(data.path));
      if (cancelled) return;
      setImg(image);
      setPhase("select");
    })().catch((e: unknown) => {
      if (!cancelled) setLoadError(e instanceof Error ? e.message : String(e));
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

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        void closeScreenshotOverlay().catch(() => undefined);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const pointInSel = (x: number, y: number): boolean =>
    sel !== null && x >= sel.x && x <= sel.x + sel.w && y >= sel.y && y <= sel.y + sel.h;

  const fullscreenSelect = useCallback(() => {
    setSel({ x: 0, y: 0, w: viewport.w, h: viewport.h });
    setTool("rect");
    setPhase("annotate");
  }, [viewport.w, viewport.h]);

  const handleRequestReselect = useCallback(() => {
    canvasRef.current?.clear();
    setSel(null);
    setTool("select");
    setPhase("select");
  }, []);

  const handleMouseDown = (e: ReactMouseEvent) => {
    if (e.button !== 0 || phase === "busy" || phase === "loading") return;
    const x = e.clientX;
    const y = e.clientY;
    if (phase === "select") {
      dragRef.current = { start: { x, y } };
      setSel({ x, y, w: 0, h: 0 });
    } else if (phase === "annotate" && !pointInSel(x, y)) {
      handleRequestReselect();
      dragRef.current = { start: { x, y } };
      setSel({ x, y, w: 0, h: 0 });
      setPhase("select");
    }
  };

  const handleMouseMove = (e: ReactMouseEvent) => {
    if (phase === "select") {
      setCursor({ x: e.clientX, y: e.clientY });
      const d = dragRef.current;
      if (d) setSel(normalizeRect(d.start, { x: e.clientX, y: e.clientY }));
    }
  };

  const handleMouseUp = () => {
    if (!dragRef.current || phase !== "select") return;
    dragRef.current = null;
    if (sel && sel.w >= MIN_SEL && sel.h >= MIN_SEL) {
      setTool("rect");
      setPhase("annotate");
    } else {
      setSel(null);
    }
  };

  const handleDoubleClick = (e: ReactMouseEvent) => {
    if (phase === "busy" || phase === "loading" || !img) return;
    if (phase === "select") {
      fullscreenSelect();
    } else if (phase === "annotate" && !pointInSel(e.clientX, e.clientY)) {
      handleRequestReselect();
    }
  };

  const toPhysical = (r: CssRect) => toPhysicalRect(r, scale);

  /** Composite base + annotations at natural size, then crop to selection. */
  const exportCropped = async (): Promise<string> => {
    const canvas = canvasRef.current;
    if (!canvas || !img) throw new Error("screenshot not ready");
    const full = canvas.exportDataUrl(img, scale);
    if (!sel) return full;
    return cropDataUrl(full, {
      x: sel.x * scale,
      y: sel.y * scale,
      w: sel.w * scale,
      h: sel.h * scale,
    });
  };

  const handleCopy = async () => {
    try {
      const dataUrl = await exportCropped();
      const file = await saveDataUrl(dataUrl);
      await copyImageToClipboard(file.path);
      showToast(t("screenshot.copied"));
      await closeScreenshotOverlay();
    } catch {
      showToast(t("screenshot.copyFailed"));
    }
  };

  const handleSave = async () => {
    try {
      const dataUrl = await exportCropped();
      const file = await saveDataUrl(dataUrl);
      const { save } = await import("@tauri-apps/plugin-dialog");
      const dest = await save({
        title: t("screenshot.save"),
        defaultPath: "screenshot.png",
        filters: [{ name: "PNG", extensions: ["png"] }],
      });
      if (typeof dest !== "string" || !dest.trim()) return;
      await saveImageToFile(file.path, dest);
      showToast(t("screenshot.saved"));
      await closeScreenshotOverlay();
    } catch {
      showToast(t("screenshot.saveFailed"));
    }
  };

  const handleScrollCapture = async () => {
    if (!init || !img || phase === "busy") return;
    setPhase("busy");
    setRecordOpen(false);
    const win = getCurrentWindow();
    await win.hide().catch(() => undefined);
    try {
      const phys = sel
        ? toPhysical(sel)
        : { x: 0, y: 0, width: init.width, height: init.height };
      const res = await scrollCapture(init.displayId ?? undefined, phys.x, phys.y, phys.width, phys.height);
      const image = await loadImage(screenshotFileUrl(res.path));
      canvasRef.current?.clear();
      setInit({ path: res.path, displayId: init.displayId, width: res.width, height: res.height });
      setImg(image);
      setSel(null);
      setTool("select");
      setPhase("select");
    } catch {
      showToast(t("screenshot.scrollFailed"));
      setPhase(sel ? "annotate" : "select");
    } finally {
      await win.show().catch(() => undefined);
      await win.setFocus().catch(() => undefined);
    }
  };

  const handleRecord = async (format: RecordFormat) => {
    if (!init || phase === "busy") return;
    setRecordOpen(false);
    const win = getCurrentWindow();
    await win.hide().catch(() => undefined);
    try {
      const region = sel ? toPhysical(sel) : null;
      await startRecording(init.displayId ?? undefined, region, format);
      // Backend opens the recorder-bar window; this overlay stays hidden.
    } catch {
      showToast(t("screenshot.recordFailed"));
      await win.show().catch(() => undefined);
      await win.setFocus().catch(() => undefined);
    }
  };

  if (loadError) {
    return (
      <div
        data-testid="screenshot-overlay"
        className="fixed inset-0 flex items-center justify-center"
        style={{ background: "#141414", color: "#ffffff" }}
      >
        <div className="text-center px-6">
          <p data-testid="screenshot-overlay-error" className="mb-4 text-[14px]">
            {loadError}
          </p>
          <button
            type="button"
            data-testid="screenshot-cancel"
            onClick={() => void closeScreenshotOverlay().catch(() => undefined)}
            className="rounded-lg px-4 py-1.5 text-[13px]"
            style={{ background: "var(--taomni-accent)", color: "#ffffff" }}
          >
            {t("screenshot.cancel")}
          </button>
        </div>
      </div>
    );
  }

  const toolbarStyle: CSSProperties = (() => {
    if (!sel) return { display: "none" };
    const h = 48;
    let top: number | undefined;
    let bottom: number | undefined;
    if (sel.y - h - 12 >= 8) {
      top = sel.y - h - 12;
    } else if (sel.y + sel.h + h + 12 <= viewport.h - 8) {
      top = sel.y + sel.h + 12;
    } else {
      bottom = 16;
    }
    const left = Math.min(Math.max(sel.x + sel.w / 2, 330), viewport.w - 330);
    return { position: "fixed", zIndex: 50, left, top, bottom, transform: "translateX(-50%)" };
  })();

  return (
    <div
      data-testid="screenshot-overlay"
      className="fixed inset-0 overflow-hidden select-none"
      style={{ background: "#000000" }}
    >
      {img && (
        <img
          data-testid="screenshot-base-image"
          src={bgUrl}
          alt=""
          draggable={false}
          className="fixed inset-0 z-0"
          style={{ width: "100%", height: "100%" }}
        />
      )}

      {/* Dim layer: full dim while selecting, selection-hole dim once selected. */}
      {phase === "select" && !sel && (
        <div
          className="fixed inset-0 z-10 pointer-events-none"
          style={{ background: "rgba(0, 0, 0, 0.35)" }}
        />
      )}
      {sel && (phase === "select" || phase === "annotate") && (
        <div
          data-testid="screenshot-selection"
          className="fixed z-30 pointer-events-none"
          style={{
            left: sel.x,
            top: sel.y,
            width: Math.max(0, sel.w),
            height: Math.max(0, sel.h),
            border: "2px solid #1677ff",
            boxShadow: "0 0 0 9999px rgba(0, 0, 0, 0.5)",
          }}
        />
      )}

      {/* Interaction layer: region drag-select. */}
      <div
        className="fixed inset-0 z-20"
        style={{ cursor: phase === "select" ? "crosshair" : "default" }}
        onMouseDown={handleMouseDown}
        onMouseMove={handleMouseMove}
        onMouseUp={handleMouseUp}
        onDoubleClick={handleDoubleClick}
      />

      {/* Annotation layer (above the interaction layer). */}
      {img && (
        <AnnotationCanvas
          ref={canvasRef}
          imageWidth={viewport.w}
          imageHeight={viewport.h}
          tool={phase === "annotate" ? tool : "select"}
          color={color}
          lineWidth={lineWidth}
          baseImage={img}
          selection={phase === "annotate" ? sel : null}
          onHistoryChange={(u, r) => {
            setCanUndo(u);
            setCanRedo(r);
          }}
          onRequestReselect={handleRequestReselect}
        />
      )}

      {/* Magnifier + size hint while selecting. */}
      {phase === "select" && img && cursor && !dragRef.current && (
        <Magnifier img={img} cursor={cursor} scale={scale} />
      )}
      {(phase === "select" || phase === "annotate") && sel && (sel.w > 0 || sel.h > 0) && (cursor || phase === "annotate") && (
        <div
          data-testid="screenshot-size-hint"
          style={{
            position: "fixed",
            zIndex: 60,
            left: Math.min((cursor ? cursor.x : sel.x + sel.w) + 16, viewport.w - 110),
            top: Math.min((cursor ? cursor.y : sel.y + sel.h) + 16, viewport.h - 40),
            pointerEvents: "none",
            background: "rgba(0, 0, 0, 0.75)",
            color: "#ffffff",
            fontSize: 12,
            padding: "3px 8px",
            borderRadius: 6,
            whiteSpace: "nowrap",
          }}
        >
          {`${Math.round(sel.w * scale)} × ${Math.round(sel.h * scale)}`}
        </div>
      )}

      {/* Toolbar after a region is selected. */}
      {phase === "annotate" && sel && (
        <div data-testid="screenshot-toolbar" style={toolbarStyle}>
          <div
            className="flex items-center gap-1 rounded-xl px-2 py-1.5 shadow-2xl"
            style={{
              background: "var(--taomni-panel-bg)",
              border: "1px solid var(--taomni-divider)",
            }}
          >
            {TOOLS.map(({ tool: name, testid, titleKey, Icon }) => (
              <ToolButton
                key={name}
                testid={testid}
                title={t(titleKey)}
                active={tool === name}
                onClick={() => setTool(name)}
              >
                <Icon size={16} />
              </ToolButton>
            ))}
            <div className="w-px h-5 mx-1" style={{ background: "var(--taomni-divider)" }} />
            {COLORS.map((c) => (
              <button
                key={c.value}
                type="button"
                data-testid={c.testid}
                title={t(c.titleKey)}
                onClick={() => setColor(c.value)}
                className="w-5 h-5 rounded-full shrink-0"
                style={{
                  background: c.value,
                  outline:
                    color === c.value
                      ? "2px solid var(--taomni-accent)"
                      : "1px solid rgba(128, 128, 128, 0.45)",
                  outlineOffset: 1,
                }}
              />
            ))}
            {LINE_WIDTHS.map((w) => (
              <button
                key={w}
                type="button"
                data-testid={`screenshot-line-width-${w}`}
                title={`${w}px`}
                onClick={() => setLineWidth(w)}
                className="w-6 h-6 rounded-md flex items-center justify-center shrink-0"
                style={{
                  background: lineWidth === w ? "var(--taomni-hover)" : "transparent",
                  color: "var(--taomni-text)",
                }}
              >
                <span
                  className="rounded-full"
                  style={{ width: w + 4, height: w + 4, background: "currentColor" }}
                />
              </button>
            ))}
            <div className="w-px h-5 mx-1" style={{ background: "var(--taomni-divider)" }} />
            <ToolButton
              testid="screenshot-undo"
              title={t("screenshot.undo")}
              disabled={!canUndo}
              onClick={() => canvasRef.current?.undo()}
            >
              <Undo2 size={16} />
            </ToolButton>
            <ToolButton
              testid="screenshot-redo"
              title={t("screenshot.redo")}
              disabled={!canRedo}
              onClick={() => canvasRef.current?.redo()}
            >
              <Redo2 size={16} />
            </ToolButton>
            <div className="w-px h-5 mx-1" style={{ background: "var(--taomni-divider)" }} />
            <ToolButton
              testid="screenshot-scroll-capture"
              title={t("screenshot.scrollCapture")}
              onClick={() => void handleScrollCapture()}
            >
              <ScrollText size={16} />
            </ToolButton>
            <div className="relative">
              <ToolButton
                testid="screenshot-record"
                title={t("screenshot.record")}
                active={recordOpen}
                onClick={() => setRecordOpen((v) => !v)}
              >
                <span className="flex items-center">
                  <Video size={16} />
                  <ChevronDown size={12} />
                </span>
              </ToolButton>
              {recordOpen && (
                <>
                  <div
                    className="fixed inset-0"
                    style={{ zIndex: 5 }}
                    onClick={() => setRecordOpen(false)}
                  />
                  <div
                    className="absolute bottom-full mb-2 left-1/2 -translate-x-1/2 rounded-lg py-1 shadow-2xl text-[12px] whitespace-nowrap"
                    style={{
                      zIndex: 10,
                      background: "var(--taomni-panel-bg)",
                      border: "1px solid var(--taomni-divider)",
                      color: "var(--taomni-text)",
                    }}
                  >
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
                </>
              )}
            </div>
            <ToolButton
              testid="screenshot-copy"
              title={t("screenshot.copy")}
              onClick={() => void handleCopy()}
            >
              <Clipboard size={16} />
            </ToolButton>
            <ToolButton
              testid="screenshot-save"
              title={t("screenshot.save")}
              onClick={() => void handleSave()}
            >
              <Download size={16} />
            </ToolButton>
            <ToolButton
              testid="screenshot-cancel"
              title={t("screenshot.cancel")}
              onClick={() => void closeScreenshotOverlay().catch(() => undefined)}
            >
              <X size={16} />
            </ToolButton>
          </div>
        </div>
      )}

      {/* Scroll-capture busy state. */}
      {phase === "busy" && (
        <div
          data-testid="screenshot-scroll-busy"
          className="fixed left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 rounded-xl px-5 py-3 text-[13px] shadow-2xl"
          style={{
            zIndex: 60,
            background: "var(--taomni-panel-bg)",
            border: "1px solid var(--taomni-divider)",
            color: "var(--taomni-text)",
          }}
        >
          {t("screenshot.scrollCapturing")}
        </div>
      )}

      {/* Bottom hint bar while selecting. */}
      {phase === "select" && !loadError && (
        <div
          className="fixed left-1/2 -translate-x-1/2 bottom-8 flex items-center gap-3 rounded-full px-4 py-2 shadow-2xl text-[13px]"
          style={{
            zIndex: 50,
            background: "var(--taomni-panel-bg)",
            border: "1px solid var(--taomni-divider)",
            color: "var(--taomni-text)",
          }}
        >
          <span data-testid="screenshot-hint">{t("screenshot.selectHint")}</span>
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

      {/* Toast. */}
      {toast && (
        <div
          data-testid="screenshot-toast"
          className="fixed left-1/2 -translate-x-1/2 bottom-20 rounded-full px-4 py-2 text-[13px] shadow-2xl"
          style={{ zIndex: 70, background: "rgba(20, 20, 20, 0.92)", color: "#ffffff" }}
        >
          {toast}
        </div>
      )}
    </div>
  );
}
