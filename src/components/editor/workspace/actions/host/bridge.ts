import { WorkspaceActionHost } from "./host";
import { type EditorActionBridgeViewRegistration } from "./types";

/**
 * §8.19.2 EditorActionBridge: every mounted EditorView registers here so
 * keyboard dispatch knows the live view set and unmounts release their
 * registrations. The host owns the registry; the bridge is the registration
 * vocabulary used by CodeMirrorHost and the window dispatcher.
 */
export class EditorActionBridge {
  constructor(private readonly host: WorkspaceActionHost) { }

  registerView(viewId: string): EditorActionBridgeViewRegistration {
    this.host.registerDispatchView(viewId);
    return {
      viewId,
      dispose: () => this.host.unregisterDispatchView(viewId),
    };
  }
}
