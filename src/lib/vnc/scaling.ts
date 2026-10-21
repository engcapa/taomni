/**
 * Viewer scaling, mirroring RealVNC Viewer's Scaling options: "auto" shrinks
 * the desktop to fit and never enlarges it, "fit"/"fit-width"/"fit-height"
 * scale in both directions, and a number is a fixed percentage where 100 maps
 * one remote pixel to one device pixel.
 */
export type VncScaling = "auto" | "fit" | "fit-width" | "fit-height" | number;

export const VNC_SCALE_PERCENTAGES = [25, 50, 75, 100, 125, 150, 200, 300, 400] as const;

export function normalizeVncScaling(value: unknown): VncScaling {
  if (value === "auto" || value === "fit" || value === "fit-width" || value === "fit-height") {
    return value;
  }
  const percent = typeof value === "string" ? Number(value) : value;
  if (typeof percent === "number" && Number.isFinite(percent) && percent >= 10 && percent <= 800) {
    return Math.round(percent);
  }
  return "auto";
}

export interface VncDisplaySize {
  /** CSS pixel size of the canvas element. */
  width: number;
  height: number;
  /** Whether the container must scroll to reveal the whole desktop. */
  scrolls: boolean;
}

/** Compute the CSS size of the desktop canvas for a scaling mode. */
export function computeVncDisplaySize(
  scaling: VncScaling,
  framebufferWidth: number,
  framebufferHeight: number,
  viewportWidth: number,
  viewportHeight: number,
  devicePixelRatio: number,
  preserveAspect = true,
): VncDisplaySize {
  const dpr = Number.isFinite(devicePixelRatio) && devicePixelRatio > 0 ? devicePixelRatio : 1;
  if (framebufferWidth <= 0 || framebufferHeight <= 0) {
    return { width: 0, height: 0, scrolls: false };
  }
  const vw = Math.max(1, viewportWidth);
  const vh = Math.max(1, viewportHeight);
  // One remote pixel per device pixel.
  const nativeWidth = framebufferWidth / dpr;
  const nativeHeight = framebufferHeight / dpr;
  const fitScaleX = vw / nativeWidth;
  const fitScaleY = vh / nativeHeight;

  let scaleX: number;
  let scaleY: number;
  switch (scaling) {
    case "auto": {
      const scale = Math.min(1, fitScaleX, fitScaleY);
      scaleX = scale;
      scaleY = scale;
      if (!preserveAspect && (fitScaleX < 1 || fitScaleY < 1)) {
        scaleX = Math.min(1, fitScaleX);
        scaleY = Math.min(1, fitScaleY);
      }
      break;
    }
    case "fit":
      if (preserveAspect) {
        scaleX = Math.min(fitScaleX, fitScaleY);
        scaleY = scaleX;
      } else {
        scaleX = fitScaleX;
        scaleY = fitScaleY;
      }
      break;
    case "fit-width":
      scaleX = fitScaleX;
      scaleY = preserveAspect ? fitScaleX : 1;
      break;
    case "fit-height":
      scaleY = fitScaleY;
      scaleX = preserveAspect ? fitScaleY : 1;
      break;
    default:
      scaleX = scaling / 100;
      scaleY = scaleX;
  }
  const width = Math.max(1, Math.round(nativeWidth * scaleX));
  const height = Math.max(1, Math.round(nativeHeight * scaleY));
  return { width, height, scrolls: width > vw + 0.5 || height > vh + 0.5 };
}
