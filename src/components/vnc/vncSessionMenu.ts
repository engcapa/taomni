import type { MenuItem } from "../ContextMenu";
import { VNC_SCALE_PERCENTAGES, type VncScaling } from "../../lib/vnc";
import type { VncPictureQuality } from "../../lib/vncOptions";

type Translate = (key: string, params?: Record<string, string | number>) => string;

export interface VncSessionMenuState {
  fullScreen: boolean;
  canFullScreen: boolean;
  viewOnly: boolean;
  ctrlLatched: boolean;
  altLatched: boolean;
  scaling: VncScaling;
  preserveAspect: boolean;
  pictureQuality: VncPictureQuality;
  /** Client-to-server clipboard allowed (Send clipboard as keystrokes). */
  clipboardToServer: boolean;
}

export interface VncSessionMenuActions {
  toggleFullScreen: () => void;
  sendF8: () => void;
  sendCtrlAltDel: () => void;
  toggleCtrl: () => void;
  toggleAlt: () => void;
  setScaling: (scaling: VncScaling) => void;
  togglePreserveAspect: () => void;
  refreshScreen: () => void;
  showSessionInfo: () => void;
  showProperties: () => void;
  setPictureQuality: (quality: VncPictureQuality) => void;
  sendClipboardAsKeys: () => void;
  closeConnection: () => void;
}

/**
 * The F8 session menu, ordered like RealVNC Viewer 7's F8 menu for a
 * third-party server. RealVNC-Server-only entries (Mute Audio, Record Session,
 * Transfer Files, Chat) and Relative Pointer Motion are not offered; see
 * DEC-VNC-05 in docs-feature/vnc-realvnc-alignment/alignment-design.md.
 */
export function buildVncSessionMenuItems(
  state: VncSessionMenuState,
  actions: VncSessionMenuActions,
  t: Translate,
): MenuItem[] {
  const inputDisabled = state.viewOnly;
  const scalingItem = (label: string, value: VncScaling, testId: string): MenuItem => ({
    label,
    testId,
    checked: state.scaling === value,
    onClick: () => actions.setScaling(value),
  });
  const qualityItem = (value: VncPictureQuality, label: string): MenuItem => ({
    label,
    testId: `vnc-quality-${value}`,
    checked: state.pictureQuality === value,
    onClick: () => actions.setPictureQuality(value),
  });
  return [
    {
      label: t("vnc.closeConnection"),
      testId: "vnc-menu-close",
      danger: true,
      onClick: actions.closeConnection,
    },
    { label: "", separator: true },
    {
      label: state.fullScreen ? t("vnc.exitFullScreen") : t("vnc.fullScreen"),
      testId: "vnc-menu-fullscreen",
      checked: state.fullScreen,
      disabled: !state.canFullScreen,
      onClick: actions.toggleFullScreen,
    },
    { label: "", separator: true },
    {
      label: t("vnc.sendF8"),
      testId: "vnc-menu-send-f8",
      disabled: inputDisabled,
      onClick: actions.sendF8,
    },
    {
      label: t("vnc.sendCtrlAltDel"),
      testId: "vnc-menu-send-cad",
      disabled: inputDisabled,
      onClick: actions.sendCtrlAltDel,
    },
    {
      label: t("vnc.sendClipboardAsKeys"),
      testId: "vnc-menu-send-clipboard-keys",
      disabled: inputDisabled || !state.clipboardToServer,
      onClick: actions.sendClipboardAsKeys,
    },
    {
      label: t("vnc.ctrlKey"),
      testId: "vnc-menu-ctrl",
      checked: state.ctrlLatched,
      disabled: inputDisabled,
      onClick: actions.toggleCtrl,
    },
    {
      label: t("vnc.altKey"),
      testId: "vnc-menu-alt",
      checked: state.altLatched,
      disabled: inputDisabled,
      onClick: actions.toggleAlt,
    },
    { label: "", separator: true },
    {
      label: t("vnc.scaleAutomatically"),
      testId: "vnc-menu-scale-auto",
      checked: state.scaling === "auto",
      onClick: () => actions.setScaling(state.scaling === "auto" ? 100 : "auto"),
    },
    {
      label: t("vnc.scaling"),
      testId: "vnc-menu-scaling",
      children: [
        scalingItem(t("vnc.scaleAutomatically"), "auto", "vnc-scale-auto"),
        scalingItem(t("vnc.scaleFitWindow"), "fit", "vnc-scale-fit"),
        scalingItem(t("vnc.scaleFitWidth"), "fit-width", "vnc-scale-fit-width"),
        scalingItem(t("vnc.scaleFitHeight"), "fit-height", "vnc-scale-fit-height"),
        { label: "", separator: true },
        ...VNC_SCALE_PERCENTAGES.map((percent) =>
          scalingItem(`${percent}%`, percent, `vnc-scale-${percent}`)),
        { label: "", separator: true },
        {
          label: t("vnc.preserveAspect"),
          testId: "vnc-scale-preserve-aspect",
          checked: state.preserveAspect,
          onClick: actions.togglePreserveAspect,
        },
      ],
    },
    {
      label: t("vnc.pictureQuality"),
      testId: "vnc-menu-quality",
      children: [
        qualityItem("automatic", t("vnc.qualityAutomatic")),
        qualityItem("high", t("vnc.qualityHigh")),
        qualityItem("medium", t("vnc.qualityMedium")),
        qualityItem("low", t("vnc.qualityLow")),
      ],
    },
    {
      label: t("vnc.refreshScreen"),
      testId: "vnc-menu-refresh",
      onClick: actions.refreshScreen,
    },
    { label: "", separator: true },
    {
      label: t("vnc.sessionInfo"),
      testId: "vnc-menu-info",
      onClick: actions.showSessionInfo,
    },
    {
      label: t("vnc.properties"),
      testId: "vnc-menu-properties",
      onClick: actions.showProperties,
    },
  ];
}
