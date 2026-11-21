import type { VncClipboardPolicy, VncSecurityPolicy } from "./model";
import type { VncScaling } from "./scaling";
import type { VncViewerOptions } from "../vncOptions";

export interface VncSessionProperties {
  viewer: VncViewerOptions;
  viewOnly: boolean;
  clipboardPolicy: VncClipboardPolicy;
}

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
  initialScaling?: VncScaling | string;
  viewerOptions?: VncViewerOptions;
  onSessionPropertiesChange?: (properties: VncSessionProperties) => void;
  onCredentialsChange?: (credentials: { username: string; password: string }) => void;
  visible: boolean;
  onDetach?: () => void;
  detachedWindowControls?: {
    onReattach: () => void;
    onToggleOsFullscreen: () => void;
    osFullscreen: boolean;
  };
}
