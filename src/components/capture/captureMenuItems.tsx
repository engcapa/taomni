import type { ReactNode } from "react";
import {
  Clipboard,
  Download,
  FileImage,
  ScrollText,
  Square,
  Video,
} from "lucide-react";
import { useCaptureStore } from "../../stores/captureStore";
import { useT } from "../../lib/i18n";

export interface CaptureMenuItem {
  key: string;
  label: string;
  icon: ReactNode;
  onClick: () => void;
  /** True while the corresponding scroll/GIF capture is running. */
  active?: boolean;
}

export function formatElapsed(ms: number): string {
  const total = Math.floor(ms / 1000);
  const m = Math.floor(total / 60).toString().padStart(2, "0");
  const s = (total % 60).toString().padStart(2, "0");
  return `${m}:${s}`;
}

/** True when the active tab has registered a capturable source. */
export function useCaptureAvailable(): boolean {
  return useCaptureStore((s) => s.source !== null);
}

/**
 * Builds the screenshot action rows for the active tab's capture source. Used
 * by the tab-strip `⋯` menu (main window) and the detached-window capture
 * button. Returns an empty list when nothing is capturable.
 *
 * `onAction` runs after each item fires — callers pass their menu-close so the
 * dropdown dismisses (e.g. before a manual scroll capture).
 */
export function useCaptureMenuItems(onAction?: () => void): CaptureMenuItem[] {
  const t = useT();
  const source = useCaptureStore((s) => s.source);
  const scrolling = useCaptureStore((s) => s.scroller !== null);
  const recording = useCaptureStore((s) => s.recorder !== null);
  const scrollFrames = useCaptureStore((s) => s.scrollFrames);
  const elapsed = useCaptureStore((s) => s.elapsed);

  if (!source) return [];

  const run = (fn: () => void | Promise<void>) => () => {
    void fn();
    onAction?.();
  };

  const items: CaptureMenuItem[] = [
    {
      key: "save-visible",
      label: t("capture.saveVisible"),
      icon: <Download size={14} />,
      onClick: run(() => useCaptureStore.getState().saveVisible()),
    },
    {
      key: "copy-clipboard",
      label: t("capture.copyClipboard"),
      icon: <Clipboard size={14} />,
      onClick: run(() => useCaptureStore.getState().copyVisible()),
    },
  ];

  if (source.getFull) {
    items.push({
      key: "save-full",
      label: t("capture.saveFull"),
      icon: <FileImage size={14} />,
      onClick: run(() => useCaptureStore.getState().saveFull()),
    });
  }

  if (source.getScrollFrame) {
    items.push({
      key: "toggle-scroll",
      label: scrolling
        ? t("capture.scrollStop", { count: scrollFrames })
        : t("capture.scrollStart"),
      icon: <ScrollText size={14} />,
      active: scrolling,
      onClick: run(() => useCaptureStore.getState().toggleScroll()),
    });
  }

  if (source.getGifFrame) {
    items.push({
      key: "toggle-gif",
      label: recording ? t("capture.gifStop", { elapsed: formatElapsed(elapsed) }) : t("capture.gifStart"),
      icon: recording ? <Square size={14} /> : <Video size={14} />,
      active: recording,
      onClick: run(() => useCaptureStore.getState().toggleGif()),
    });
  }

  return items;
}
