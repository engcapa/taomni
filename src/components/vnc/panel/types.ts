import type { VncClipboardPolicy, VncScaling, VncSecurityPolicy } from "../../../lib/vnc";
import { type VncViewerOptions } from "../../../lib/vncOptions";
import { type VncSessionProperties } from "../VncPropertiesDialog";
import { type VncPointerState } from "../../../lib/vncPointerScheduler";


export interface VncPanelProps {
  tabId: string;
  host: string;
  port: number;
  username?: string | null;
  password?: string;
  networkSettingsJson?: string | null;
  securityPolicy?: VncSecurityPolicy;
  viewOnly?: boolean;
  clipboardPolicy?: VncClipboardPolicy;
  /** Initial viewer scaling ("auto", "fit", "fit-width", "fit-height" or a percentage). */
  initialScaling?: VncScaling | string;
  /** Saved per-session viewer options (VNC-CONN-001); defaults match RealVNC. */
  viewerOptions?: VncViewerOptions;
  /** Persist changed viewer / reconnect-time settings back to the session. */
  onSessionPropertiesChange?: (properties: VncSessionProperties) => void;
  /** "Remember password" from the in-session authentication form. */
  onCredentialsChange?: (credentials: { username: string; password: string; }) => void;
  visible: boolean;
  onDetach?: () => void;
  detachedWindowControls?: {
    onReattach: () => void;
    onToggleOsFullscreen: () => void;
    osFullscreen: boolean;
  };
}

export type DelayedPointerDown = {
  pointerId: number;
  down: VncPointerState;
  up: VncPointerState | null;
};
