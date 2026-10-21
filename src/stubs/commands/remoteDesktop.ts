import { vncBridgeCancel, vncBridgeConnect, vncBridgeDisconnect, vncBridgeTest } from "../vncClient";

export async function invokeRemoteDesktop<T>(cmd: string, args?: any): Promise<T> {
  switch (cmd) {

    case "vnc_connect":
      // Proxy / jump-host rows are ignored here, as for SSH in the preview.
      return await vncBridgeConnect<T>(args);

    case "vnc_test_connection":
      return await vncBridgeTest<T>(args);

    case "vnc_disconnect":
      await vncBridgeDisconnect(args?.sessionId);
      return undefined as T;

    case "vnc_cancel_connect":
      return (await vncBridgeCancel(args?.attemptId)) as T;

    // ---------- RDP commands (desktop-only) ----------
    case "rdp_connect":

    case "rdp_disconnect":

    case "rdp_test_connection": {
      throw new Error(
        "RDP is only available in the desktop build of Taomni, not in browser preview.",
      );
    }
    default: throw new Error(`Unhandled remoteDesktop stub command: ${cmd}`);
  }
}
