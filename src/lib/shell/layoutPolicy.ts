import type { DockEdge } from "./types";

export interface LayoutRequest {
  width: number; height: number; railWidth?: number; quickConnectHeight?: number;
  navigatorRequested: boolean; navigatorWidth: number;
  navigatorExplicit?: boolean;
  rightRequested?: boolean; rightSize?: number; bottomRequested?: boolean; bottomSize?: number;
  taoOpen?: boolean; taoEdge?: DockEdge; taoPinned?: boolean; taoWidth?: number; taoHeight?: number;
}
export interface ShellLayout {
  mode: "wide" | "medium" | "overlay" | "compact";
  titlebarHeight: number; bodyHeight: number; navigator: "hidden" | "dock" | "overlay";
  navigatorWidth: number; right: "hidden" | "dock" | "overlay"; rightSize: number;
  bottom: "hidden" | "dock" | "overlay"; bottomSize: number; tao: "hidden" | "dock" | "overlay";
  taoSize: number;
}
export const clampSize = (value: number, min: number, max: number): number =>
  Math.min(Math.max(min, max), Math.max(min, Number.isFinite(value) ? value : min));
export function solveShellLayout(r: LayoutRequest): ShellLayout {
  const width = Math.max(0, r.width), height = Math.max(0, r.height);
  const titlebarHeight = width < 560 ? 84 : 42;
  const bodyHeight = Math.max(0, height - titlebarHeight - 22 - (r.quickConnectHeight ?? 0));
  const available = Math.max(0, width - (r.railWidth ?? 52));
  const overlayWidth = Math.max(0, available - 16);
  const mode = width >= 1200 ? "wide" : width >= 960 ? "medium" : width >= 720 ? "overlay" : "compact";
  const navWidth = clampSize(r.navigatorWidth, 200, Math.min(400, width * .32));
  const rightSize = clampSize(r.rightSize ?? 330, 280, Math.min(600, width * .42));
  const bottomSize = clampSize(r.bottomSize ?? 280, 220, bodyHeight * .45);
  const sideTao = r.taoEdge !== "top" && r.taoEdge !== "bottom";
  const taoSize = sideTao ? clampSize(r.taoWidth ?? 360, 300, Math.min(600, width * .42))
    : clampSize(r.taoHeight ?? 280, 220, bodyHeight * .45);
  let navigator: ShellLayout["navigator"] = r.navigatorRequested ? (width >= 1200 || (width >= 960 && r.navigatorExplicit) ? "dock" : "overlay") : "hidden";
  let right: ShellLayout["right"] = r.rightRequested ? (width >= 960 ? "dock" : "overlay") : "hidden";
  let bottom: ShellLayout["bottom"] = r.bottomRequested ? (width >= 960 && bodyHeight - bottomSize >= 240 ? "dock" : "overlay") : "hidden";
  let tao: ShellLayout["tao"] = r.taoOpen ? (width >= 960 && r.taoPinned ? "dock" : "overlay") : "hidden";
  if (r.taoOpen) {
    if (r.taoEdge === "right") right = "hidden";
    if (r.taoEdge === "bottom") bottom = "hidden";
    if (r.taoEdge === "left") navigator = "hidden";
    if (!sideTao && bodyHeight - taoSize < 240) tao = "overlay";
  }
  const usedWidth = () => (navigator === "dock" ? navWidth + 6 : 0) + (right === "dock" ? rightSize : 0)
    + (tao === "dock" && sideTao ? taoSize : 0);
  if (available - usedWidth() < 480 && navigator === "dock") navigator = "overlay";
  if (available - usedWidth() < 480 && right === "dock") right = "overlay";
  if (available - usedWidth() < 480 && tao === "dock" && sideTao) tao = "overlay";
  return { mode, titlebarHeight, bodyHeight, navigator, navigatorWidth: navigator === "overlay" ? Math.min(navWidth, overlayWidth) : navWidth,
    right, rightSize: right === "overlay" ? Math.min(rightSize, overlayWidth) : rightSize,
    bottom, bottomSize: bottom === "overlay" ? Math.min(bottomSize, Math.max(0, bodyHeight - 16)) : bottomSize,
    tao, taoSize: tao === "overlay" ? Math.min(taoSize, sideTao ? overlayWidth : Math.max(0, bodyHeight - 16)) : taoSize };
}
