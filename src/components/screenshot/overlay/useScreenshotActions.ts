import { formatUnknownError } from "../../../lib/appDialogs";
import {
  autoRedact,
  closeScreenshotOverlay,
  copyImageToClipboard,
  ocrImage,
  openImageEditor,
  pinToScreen,
  saveDataUrl,
  saveImageToFile,
  scrollCapture,
  scrollPlan,
  startRecording,
  switchScreenshotDisplay,
  updateOverlayImage,
  updateSourcePin,
  type RecordFormat,
} from "../../../lib/screenshot";
import { drawEdited, editedSize, type ImageEdit } from "../../../lib/screenshotImage";
import { maskContour } from "../../../lib/screenshotSelection";
import { type Shape } from "../AnnotationCanvas";
import { applyWatermark, cropDataUrl, loadArtifact, loadImage } from "./images";
import { type ImageSnapshot } from "./types";
import { useScreenshotOverlayKeyboard } from "./useScreenshotOverlayKeyboard";
import { useScreenshotOverlayPlacement } from "./useScreenshotOverlayPlacement";
import { useScreenshotOverlayState } from "./useScreenshotOverlayState";
import { useScreenshotSelection } from "./useScreenshotSelection";

export interface UseScreenshotActionsContext {
  state: ReturnType<typeof useScreenshotOverlayState>;
  selection: ReturnType<typeof useScreenshotSelection>;
}

export function useScreenshotActions(context: UseScreenshotActionsContext) {
  const { state, selection } = context;

  // ---------------------------------------------------------------------
  // Output
  // ---------------------------------------------------------------------

  /** Composite base + annotations at natural size, cropped to the selection. */
  const exportCropped = async (includeWatermark = true): Promise<string> => {
    const canvas = state.canvasRef.current;
    if (!canvas || !state.img) throw new Error("screenshot not ready");
    const full = canvas.exportDataUrl(state.img, state.sx, state.sy);
    let out = state.sel ? await cropDataUrl(full, state.toPhysical(state.sel)) : full;
    if (includeWatermark && state.watermark && state.watermark.text.trim()) out = await applyWatermark(out, state.watermark);
    if (state.contour && state.sel) {
      const image = await loadImage(out);
      const c = document.createElement("canvas");
      c.width = image.naturalWidth;
      c.height = image.naturalHeight;
      const ctx = c.getContext("2d");
      if (!ctx) throw new Error("canvas 2d context unavailable");
      ctx.drawImage(image, 0, 0);
      maskContour(ctx, state.contour, state.sx, state.sy, state.toPhysical(state.sel));
      out = c.toDataURL("image/png");
    }
    return out;
  };

  /** Run an output action once (buttons + shortcuts can race). */
  const runBusy = async (action: () => Promise<void>) => {
    if (state.busyRef.current) return;
    state.busyRef.current = true;
    state.setBusy(true);
    try {
      await action();
    } finally {
      state.busyRef.current = false;
      state.setBusy(false);
    }
  };

  const imageSnapshot = (): ImageSnapshot | null => state.img && state.imgUrl ? {
    img: state.img, url: state.imgUrl, selection: state.sel, contour: state.contour, result: state.scrollResult, shapes: state.canvasRef.current?.snapshot() ?? [],
  } : null;

  const restoreImage = (snapshot: ImageSnapshot) => {
    state.setImg(snapshot.img); state.setImgUrl(snapshot.url); state.setSel(snapshot.selection); state.setContour(snapshot.contour);
    state.setScrollResult(snapshot.result); state.setPhase(snapshot.result ? "preview" : "annotate");
    state.setTool("move"); state.pendingShapes.current = snapshot.shapes;
  };
  const undoImage = () => {
    const current = imageSnapshot(), previous = state.imageUndo.at(-1);
    if (!current || !previous || state.editBusy) return;
    state.setImageRedo((list) => [...list, current]); state.setImageUndo((list) => list.slice(0, -1)); restoreImage(previous);
  };
  const redoImage = () => {
    const current = imageSnapshot(), next = state.imageRedo.at(-1);
    if (!current || !next || state.editBusy) return;
    state.setImageUndo((list) => [...list, current]); state.setImageRedo((list) => list.slice(0, -1)); restoreImage(next);
  };
  const editImage = (edit: ImageEdit) => runBusy(async () => {
    const before = imageSnapshot();
    if (!before) return;
    state.setEditBusy(true);
    try {
      const image = await loadImage(await exportCropped(false));
      const size = editedSize(image.naturalWidth, image.naturalHeight, edit);
      const canvas = document.createElement("canvas"); canvas.width = size.width; canvas.height = size.height;
      const ctx = canvas.getContext("2d"); if (!ctx) throw new Error("canvas unavailable");
      drawEdited(ctx, image, image.naturalWidth, image.naturalHeight, edit);
      const url = canvas.toDataURL("image/png");
      const loaded = await loadImage(url);
      state.setImageUndo((list) => [...list.slice(-7), before]); state.setImageRedo([]);
      // Edits bake annotations into a new background. Image undo retains the
      // original vector shapes; restore them after switching canvas hosts.
      state.setImg(loaded); state.setImgUrl(url); state.setScrollResult({ frames: state.scrollResult?.frames ?? 0, w: size.width, h: size.height });
      state.setSel({ x: 0, y: 0, w: size.width, h: size.height }); state.setContour(null);
      state.canvasRef.current?.clear(); state.setTool("move"); state.setPhase("preview");
    } catch (e) { state.showToast(formatUnknownError(e)); }
    finally { state.setEditBusy(false); }
  });
  const externalEdit = (choose: boolean) => runBusy(async () => {
    try {
      let editor: string | undefined;
      if (choose) {
        const { open } = await import("@tauri-apps/plugin-dialog");
        const selected = await open({ title: state.t("screenshot.chooseEditor"), multiple: false, directory: false });
        if (typeof selected !== "string") return;
        editor = selected;
      }
      const file = await saveDataUrl(await exportCropped());
      await openImageEditor(file.path, editor);
      await closeScreenshotOverlay();
    } catch (e) { state.showToast(formatUnknownError(e)); }
  });

  const finishPinEdit = (action: "replace" | "new" | "copy") => runBusy(async () => {
    try {
      const file = await saveDataUrl(await exportCropped());
      await copyImageToClipboard(file.path);
      if (action === "replace") await updateSourcePin(file.path);
      if (action === "new") await pinToScreen(file.path);
      await closeScreenshotOverlay();
    } catch (e) { state.showToast(formatUnknownError(e)); }
  });

  const changeDisplay = (displayId: string) => runBusy(async () => {
    try {
      const data = await switchScreenshotDisplay(displayId);
      const loaded = await loadArtifact(data.path);
      state.canvasRef.current?.clear();
      state.setInit(data); state.setImg(loaded.img); state.setImgUrl(loaded.url);
      state.setSel(null); state.setContour(null); state.setPhase("select"); state.setTool("select");
    } catch (e) { state.showToast(formatUnknownError(e)); }
  });

  const handleCopy = () => {
    if (state.init?.sourcePin) { state.setPinDoneOpen(true); return; }
    return copyAndClose();
  };

  const copyAndClose = () =>
    runBusy(async () => {
      try {
        const file = await saveDataUrl(await exportCropped());
        await copyImageToClipboard(file.path);
        state.showToast(state.t("screenshot.copied"));
        await closeScreenshotOverlay();
      } catch (e) {
        state.showToast(state.t("screenshot.copyFailed", { error: formatUnknownError(e) }));
      }
    });

  const handleSave = () =>
    runBusy(async () => {
      try {
        const file = await saveDataUrl(await exportCropped());
        const { save } = await import("@tauri-apps/plugin-dialog");
        const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
        const dest = await save({
          title: state.t("screenshot.save"),
          defaultPath: `Taomni-${stamp}.png`,
          filters: [{ name: "PNG", extensions: ["png"] }],
        });
        if (typeof dest !== "string" || !dest.trim()) return;
        await saveImageToFile(file.path, dest);
        state.showToast(state.t("screenshot.saved"));
        await closeScreenshotOverlay();
      } catch (e) {
        state.showToast(state.t("screenshot.saveFailed", { error: formatUnknownError(e) }));
      }
    });

  const handlePin = () =>
    runBusy(async () => {
      try {
        const file = await saveDataUrl(await exportCropped());
        await pinToScreen(file.path);
        await closeScreenshotOverlay();
      } catch (e) {
        state.showToast(state.t("screenshot.pinFailed", { error: formatUnknownError(e) }));
      }
    });

  const handleOcr = () =>
    runBusy(async () => {
      state.setOcrLoading(true);
      state.setOcrOpen(true);
      state.setOcrText("");
      try {
        const file = await saveDataUrl(await exportCropped());
        const res = await ocrImage(file.path);
        state.setOcrText(res.text || state.t("screenshot.ocrEmpty"));
      } catch (e) {
        state.setOcrText(state.t("screenshot.ocrFailed", { error: formatUnknownError(e) }));
      } finally {
        state.setOcrLoading(false);
      }
    });

  /** Auto-redact e-mail / phone / ID tokens found by OCR. */
  const handleAutoRedact = () =>
    runBusy(async () => {
      try {
        const file = await saveDataUrl(await exportCropped());
        const res = await autoRedact(file.path);
        if (res.count === 0) {
          state.showToast(state.t("screenshot.redactNone"));
          return;
        }
        // Boxes are physical pixels of the exported (cropped) image.
        const ox = state.sel ? state.sel.x : 0;
        const oy = state.sel ? state.sel.y : 0;
        const shapes: Shape[] = res.boxes.map((b) => ({
          id: -1,
          kind: "mosaic" as const,
          color: "#000000",
          lineWidth: 2,
          x: ox + b.x / state.sx,
          y: oy + b.y / state.sy,
          w: b.w / state.sx,
          h: b.h / state.sy,
        }));
        state.canvasRef.current?.addShapes(shapes);
        state.showToast(state.t("screenshot.redacted", { count: res.count }));
      } catch (e) {
        state.showToast(state.t("screenshot.redactFailed", { error: formatUnknownError(e) }));
      }
    });

  const confirmScroll = async () => {
    if (!state.sel || !state.init) return;
    state.setScrollConfirm(true); state.setRecordOpen(false); state.setPlanningScroll(true); state.setPlannedRegion(null); state.setScrollError(null);
    try { state.setPlannedRegion(await scrollPlan(state.init.displayId || undefined, state.toPhysical(state.sel))); }
    catch (e) { state.setScrollError(formatUnknownError(e)); state.setScrollConfirm(false); }
    finally { state.setPlanningScroll(false); }
  };

  const handleScrollCapture = () =>
    runBusy(async () => {
      if (!state.init || !state.img || !state.sel || state.contour || !state.plannedRegion) return;
      state.setPhase("busy");
      state.setScrollError(null);
      state.setRecordOpen(false);
      state.setScrollConfirm(false);
      try {
        // The backend hides this window while it scrolls, then shows it.
        const res = await scrollCapture(state.init.displayId || undefined, state.plannedRegion, state.scrollMode);
        const loaded = await loadArtifact(res.path);
        await updateOverlayImage(res).catch(() => undefined);
        state.canvasRef.current?.clear();
        state.setInit({ ...state.init, path: res.path, width: res.width, height: res.height });
        state.setImg(loaded.img);
        state.setImgUrl(loaded.url);
        const size = { w: loaded.img.naturalWidth, h: loaded.img.naturalHeight };
        state.setScrollResult({ frames: res.frames, ...size });
        state.setSel({ x: 0, y: 0, ...size });
        state.setContour(null);
        state.setTool("move");
        state.setPhase("preview");
      } catch (e) {
        if (!String(e).includes("scroll capture cancelled")) state.setScrollError(formatUnknownError(e));
        state.setPhase("annotate");
      }
    });

  const handleRecord = (format: RecordFormat) =>
    runBusy(async () => {
      if (!state.init || !state.sel || state.contour) return;
      state.setScrollError(null);
      state.setRecordOpen(false);
      state.setPhase("busy");
      try {
        // The backend closes this overlay and opens the recorder bar.
        await startRecording(state.init.displayId || undefined, state.toPhysical(state.sel), format);
      } catch (e) {
        state.showToast(state.t("screenshot.recordFailed", { error: formatUnknownError(e) }));
        state.setPhase("annotate");
      }
    });
  useScreenshotOverlayKeyboard({
    state,
    selection,
    handleCopy,
    handleSave,
  });
  useScreenshotOverlayPlacement({
    state,
  });

  return {
    handleCopy,
    confirmScroll,
    handlePin,
    handleOcr,
    handleAutoRedact,
    handleRecord,
    handleSave,
    changeDisplay,
    finishPinEdit,
    handleScrollCapture,
    editImage,
    undoImage,
    redoImage,
    externalEdit,
  };
}
