import type { RdpOptions } from "../../../types/rdp";

export interface RdpPanelProps {
  tabId: string;
  host: string;
  port: number;
  username?: string | null;
  password?: string;
  options: RdpOptions;
  networkSettingsJson?: string | null;
  visible: boolean;
  /** Callback for the toolbar Detach button. When undefined, the button
   *  is hidden — used by the detached window itself, which should show
   *  Reattach instead. */
  onDetach?: () => void;
  /** When set, the toolbar shows an AI-chat toggle bound to this tab.
   *  Hidden in detached windows (no ChatDrawer lives there). */
  chatToggle?: {
    open: boolean;
    onToggle: () => void;
  };
  detachedWindowControls?: {
    onReattach: () => void;
    onToggleOsFullscreen: () => void;
    osFullscreen: boolean;
  };
}

export type ScaleMode = "fit" | "one";

// View state for the single "enlarge" button: normal <-> OS fullscreen.
export type ViewMode = "normal" | "fullscreen";
