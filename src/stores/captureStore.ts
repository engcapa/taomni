import { create } from "zustand";
import {
  copyImageBlobToClipboard,
  createGifRecorder,
  type GifRecorder,
  saveBlobToFile,
  safeFilePart,
  startScrollCapture,
  type ScrollCapture,
  timestampFilePart,
} from "../lib/capture";
import { t } from "../lib/i18n";

/**
 * Capture handlers supplied by whichever tab is currently active. A capturable
 * tab registers its source while active and clears it on deactivate/unmount,
 * so the screenshot menu (folded into the tab-strip `⋯` overflow) and the
 * detached-window capture button always target the visible content.
 *
 * Mirrors the props the old `CaptureToolbar` took; the orchestration that used
 * to live in that component now lives here so a single engine can drive both
 * the menu items and the in-progress indicator pills.
 */
export interface CaptureSource {
  filenamePrefix: string;
  getVisible: () => Promise<Blob>;
  /** Whole-buffer snapshot (e.g. xterm scrollback / full framebuffer). */
  getFull?: () => Promise<Blob>;
  /** Frame source for live scroll capture (start → manual scroll → stop). */
  getScrollFrame?: () => Promise<CanvasImageSource | null> | CanvasImageSource | null;
  getGifFrame?: () => Promise<CanvasImageSource | null> | CanvasImageSource | null;
  onStatus?: (msg: string) => void;
}

interface CaptureState {
  source: CaptureSource | null;
  recorder: GifRecorder | null;
  scroller: ScrollCapture | null;
  recordingStartedAt: number | null;
  elapsed: number;
  scrollFrames: number;

  setSource: (source: CaptureSource) => void;
  /** Clears only if `source` is still the registered one, so a late unmount of
   *  a previous tab can't wipe the new active tab's registration. An in-flight
   *  recording/scroll is left running (it holds its own frame source). */
  clearSource: (source: CaptureSource) => void;

  saveVisible: () => Promise<void>;
  copyVisible: () => Promise<void>;
  saveFull: () => Promise<void>;
  toggleScroll: () => void;
  toggleGif: () => void;
}

// Filename prefix captured when a scroll/GIF capture starts, so the saved file
// keeps the originating tab's name even if the user switches tabs mid-capture.
let activePrefix = "capture";
let elapsedTimer: number | null = null;

function status(msg: string) {
  useCaptureStore.getState().source?.onStatus?.(msg);
}

function baseName(ext: "png" | "gif"): string {
  return `${safeFilePart(activePrefix)}-${timestampFilePart()}.${ext}`;
}

export const useCaptureStore = create<CaptureState>((set, get) => ({
  source: null,
  recorder: null,
  scroller: null,
  recordingStartedAt: null,
  elapsed: 0,
  scrollFrames: 0,

  setSource: (source) => set({ source }),
  clearSource: (source) => {
    if (get().source === source) set({ source: null });
  },

  saveVisible: async () => {
    const { source } = get();
    if (!source) return;
    activePrefix = source.filenamePrefix;
    try {
      const blob = await source.getVisible();
      const saved = await saveBlobToFile(blob, baseName("png"));
      status(saved ? t("capture.statusSaved", { path: saved }) : t("capture.statusSaveCanceled"));
    } catch (err) {
      status(err instanceof Error ? err.message : t("capture.statusScreenshotFailed"));
    }
  },

  copyVisible: async () => {
    const { source } = get();
    if (!source) return;
    try {
      const blob = await source.getVisible();
      await copyImageBlobToClipboard(blob);
      status(t("capture.statusCopy"));
    } catch (err) {
      status(err instanceof Error ? err.message : t("capture.statusCopyFailed"));
    }
  },

  saveFull: async () => {
    const { source } = get();
    if (!source?.getFull) return;
    activePrefix = source.filenamePrefix;
    try {
      status(t("capture.statusCapturingScroll"));
      const blob = await source.getFull();
      const saved = await saveBlobToFile(blob, baseName("png"));
      status(saved ? t("capture.statusSavedScroll", { path: saved }) : t("capture.statusSaveCanceled"));
    } catch (err) {
      status(err instanceof Error ? err.message : t("capture.statusScrollCaptureFailed"));
    }
  },

  toggleScroll: () => {
    const { source, scroller } = get();
    if (scroller) {
      status(t("capture.statusScrollFinalizing"));
      void (async () => {
        try {
          const blob = await scroller.stop();
          if (blob.size === 0) {
            status(t("capture.statusScrollNoFrames"));
          } else {
            const saved = await saveBlobToFile(blob, baseName("png"));
            status(saved ? t("capture.statusSavedScroll", { path: saved }) : t("capture.statusSaveCanceled"));
          }
        } catch (err) {
          status(err instanceof Error ? err.message : t("capture.statusScrollCaptureFailed"));
        } finally {
          set({ scroller: null, scrollFrames: 0 });
        }
      })();
      return;
    }
    if (!source?.getScrollFrame) return;
    activePrefix = source.filenamePrefix;
    set({ scrollFrames: 0 });
    const s = startScrollCapture({
      getFrame: source.getScrollFrame,
      intervalMs: 250,
      onProgress: (info) => set({ scrollFrames: info.frames }),
    });
    set({ scroller: s });
    status(t("capture.statusScrollStarted"));
  },

  toggleGif: () => {
    const { source, recorder } = get();
    if (recorder) {
      status(t("capture.statusGifEncoding"));
      void (async () => {
        try {
          const blob = await recorder.stop();
          if (blob.size > 0) {
            const saved = await saveBlobToFile(blob, baseName("gif"));
            status(
              saved
                ? t("capture.statusGifSaved", { size: (blob.size / 1024 / 1024).toFixed(1), path: saved })
                : t("capture.statusGifSaveCanceled"),
            );
          } else {
            status(t("capture.statusGifNoFrames"));
          }
        } catch (err) {
          status(err instanceof Error ? err.message : t("capture.statusGifFailed"));
        } finally {
          if (elapsedTimer !== null) {
            window.clearInterval(elapsedTimer);
            elapsedTimer = null;
          }
          set({ recorder: null, recordingStartedAt: null, elapsed: 0 });
        }
      })();
      return;
    }
    if (!source?.getGifFrame) return;
    activePrefix = source.filenamePrefix;
    const r = createGifRecorder({
      fps: 10,
      maxFrames: 600,
      maxWidth: 1280,
      getFrame: source.getGifFrame,
      onFrame: () => {},
    });
    r.start();
    const startedAt = Date.now();
    set({ recorder: r, recordingStartedAt: startedAt, elapsed: 0 });
    if (elapsedTimer !== null) window.clearInterval(elapsedTimer);
    elapsedTimer = window.setInterval(() => set({ elapsed: Date.now() - startedAt }), 250);
    status(t("capture.statusRecording"));
  },
}));
