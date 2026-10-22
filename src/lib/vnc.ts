export { parseVncError } from "./vnc/validation";

export {
  type VncClipboardPolicy,
  type VncConnectExtras,
  type VncConnectResult,
  type VncDetachClaim,
  type VncNativePointerTarget,
  type VncSecurityPolicy,
  type VncSessionStats,
  type VncStructuredError,
  type WsIncoming,
  type WsOutgoing,
} from "./vnc/model";

export { redactVncHandoff, vncCancelConnect, vncConnect, vncConsumeDetachClaim, vncCreateDetachClaim, vncDisconnect, vncTestConnection } from "./vnc/connection";

export {
  encodeWsAck,
  encodeWsKey,
  encodeWsPing,
  encodeWsPointer,
  encodeWsQuality,
  encodeWsRefresh,
  parseFrameHeader,
  parseWsMessage,
  vncCursorToCss,
} from "./vnc/wire";

export { VNC_KEYSYM, codePointToKeysym, iterCodePoints, keyEventToKeysym } from "./vnc/keyboard";

export {
  VNC_WHEEL_DOWN,
  VNC_WHEEL_LEFT,
  VNC_WHEEL_PIXELS_PER_STEP,
  VNC_WHEEL_RIGHT,
  VNC_WHEEL_UP,
  VncWheelAccumulator,
  mapClientToFramebuffer,
  mouseButtonMask,
  type VncFramebufferPoint,
  type VncViewportRect,
} from "./vnc/pointer";

export { VNC_SCALE_PERCENTAGES, computeVncDisplaySize, normalizeVncScaling, type VncDisplaySize, type VncScaling } from "./vnc/scaling";
