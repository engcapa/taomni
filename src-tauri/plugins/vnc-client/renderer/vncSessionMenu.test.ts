import { describe, expect, it, vi } from "vitest";
import { buildVncSessionMenuItems, type VncSessionMenuActions, type VncSessionMenuState } from "./vncSessionMenu";

const t = (key: string) => key;

function actions(): VncSessionMenuActions {
  return {
    toggleFullScreen: vi.fn(),
    sendF8: vi.fn(),
    sendCtrlAltDel: vi.fn(),
    toggleCtrl: vi.fn(),
    toggleAlt: vi.fn(),
    setScaling: vi.fn(),
    togglePreserveAspect: vi.fn(),
    refreshScreen: vi.fn(),
    showSessionInfo: vi.fn(),
    showProperties: vi.fn(),
    setPictureQuality: vi.fn(),
    sendClipboardAsKeys: vi.fn(),
    closeConnection: vi.fn(),
  };
}

const BASE: VncSessionMenuState = {
  fullScreen: false,
  canFullScreen: true,
  viewOnly: false,
  ctrlLatched: false,
  altLatched: false,
  scaling: "auto",
  preserveAspect: true,
  pictureQuality: "automatic",
  clipboardToServer: true,
};

describe("VNC session menu (RealVNC F8 order)", () => {
  it("keeps RealVNC's F8 order for third-party servers", () => {
    const labels = buildVncSessionMenuItems(BASE, actions(), t)
      .filter((item) => !item.separator)
      .map((item) => item.testId);
    expect(labels).toEqual([
      "vnc-menu-close",
      "vnc-menu-fullscreen",
      "vnc-menu-send-f8",
      "vnc-menu-send-cad",
      "vnc-menu-send-clipboard-keys",
      "vnc-menu-ctrl",
      "vnc-menu-alt",
      "vnc-menu-scale-auto",
      "vnc-menu-scaling",
      "vnc-menu-quality",
      "vnc-menu-refresh",
      "vnc-menu-info",
      "vnc-menu-properties",
    ]);
  });

  it("reflects latched modifiers, scaling and view-only state", () => {
    const items = buildVncSessionMenuItems(
      { ...BASE, viewOnly: true, ctrlLatched: true, scaling: 150 },
      actions(),
      t,
    );
    const byId = new Map(items.map((item) => [item.testId, item]));
    expect(byId.get("vnc-menu-ctrl")).toMatchObject({ checked: true, disabled: true });
    expect(byId.get("vnc-menu-send-cad")?.disabled).toBe(true);
    expect(byId.get("vnc-menu-scale-auto")?.checked).toBe(false);
    const scaling = byId.get("vnc-menu-scaling")?.children ?? [];
    expect(scaling.find((item) => item.testId === "vnc-scale-150")?.checked).toBe(true);
    expect(scaling.find((item) => item.testId === "vnc-scale-preserve-aspect")?.checked).toBe(true);
  });

  it("toggles Scale Automatically to 100% and back", () => {
    const handlers = actions();
    buildVncSessionMenuItems(BASE, handlers, t).find((item) => item.testId === "vnc-menu-scale-auto")?.onClick?.();
    expect(handlers.setScaling).toHaveBeenCalledWith(100);
    buildVncSessionMenuItems({ ...BASE, scaling: 100 }, handlers, t)
      .find((item) => item.testId === "vnc-menu-scale-auto")?.onClick?.();
    expect(handlers.setScaling).toHaveBeenLastCalledWith("auto");
  });

  it("offers RealVNC picture quality presets and gates clipboard keystrokes", () => {
    const handlers = actions();
    const items = buildVncSessionMenuItems({ ...BASE, pictureQuality: "medium", clipboardToServer: false }, handlers, t);
    const quality = items.find((item) => item.testId === "vnc-menu-quality")?.children ?? [];
    expect(quality.map((item) => item.testId)).toEqual([
      "vnc-quality-automatic",
      "vnc-quality-high",
      "vnc-quality-medium",
      "vnc-quality-low",
    ]);
    expect(quality.find((item) => item.testId === "vnc-quality-medium")?.checked).toBe(true);
    quality.find((item) => item.testId === "vnc-quality-low")?.onClick?.();
    expect(handlers.setPictureQuality).toHaveBeenCalledWith("low");
    expect(items.find((item) => item.testId === "vnc-menu-send-clipboard-keys")?.disabled).toBe(true);
  });
});
