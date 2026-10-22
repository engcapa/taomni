import { isTauriRuntime } from "../../lib/runtime";
import { openSftpWindow } from "../../lib/sftp";
import { openDetachedWindow } from "../../lib/detachWindowing";
import { clearDetachedHandoff, detachedWindowUrl, writeDetachedHandoff } from "../../components/filebrowser/SftpDetachedWindow";
import { writeDetachedHandoff as writeGenericHandoff, clearDetachedHandoff as clearGenericHandoff, detachedWindowUrl as detachedGenericUrl, type DetachedKind } from "../../lib/detachedSession";
import type { DetachedRdpParams, DetachedVncParams, DetachedTerminalParams, DetachedDbParams } from "../../components/detached/DetachedSessionWindow";
import { redactVncHandoff, vncCreateDetachClaim } from "../../lib/vnc";
import { serializeVncViewerOptions } from "../../lib/vncOptions";
import type { SftpTabInfo, Tab } from "../../types";
import { useAppStore } from "../../stores/appStore";
import { type TerminalProfile } from "../../lib/terminalProfile";
import { getTerminal, markTerminalDetachPending, clearTerminalDetachPending } from "../../lib/terminal/terminalRegistry";
import { t as tr } from "../../lib/i18n";


export interface OpenDetachedSftpContext {
  setStatusMessage: (message: string) => void;
}


export function createOpenDetachedSftp(controllerContext: OpenDetachedSftpContext): (params: SftpTabInfo, title: string) => void {
  return (params: SftpTabInfo, title: string) => {
    // Use a DIFFERENT session id for the detached window so its backend
    // SFTP channel is independent from the sidebar's. Without this, the
    // popup and the sidebar share one `Arc<Mutex<SftpSession>>` and any
    // long transfer in one window stalls clicks/listings in the other.
    // The suffix is stable per parent so re-clicking "Detach" focuses the
    // existing popup instead of opening a second one.
    const detachedSessionId = `${params.sessionId}__detached`;
    writeDetachedHandoff({
      ...params,
      sessionId: detachedSessionId,
      parentSessionId: params.sessionId,
      title,
    });
    if (isTauriRuntime()) {
      // Native: open a real OS window via the Rust command. The handoff
      // payload was just written to localStorage above so the new window
      // can read it on mount. If launching the OS window fails we must
      // wipe the handoff immediately — otherwise the credentials sit on
      // disk for the rest of the run with no one waiting to consume them.
      void openSftpWindow(detachedSessionId, title).catch((err) => {
        clearDetachedHandoff(detachedSessionId);
        controllerContext.setStatusMessage(tr("status.sftpWindowError", {
          error: err instanceof Error ? err.message : String(err),
        }));
      });
      return;
    }
    const url = detachedWindowUrl(detachedSessionId);
    const features = "width=1200,height=760,resizable=yes,scrollbars=yes";
    const handle = window.open(url, `taomni_sftp_${detachedSessionId}`, features);
    if (!handle) {
      // Pop-up blocked — clean up the credential blob right away so it
      // doesn't linger in localStorage waiting for a window that never
      // arrives.
      clearDetachedHandoff(detachedSessionId);
      controllerContext.setStatusMessage(tr("status.sftpPopupBlocked"));
    }
  };
}



export interface OpenDetachedGenericWindowContext {
  removeTab: (id: string) => void;
  setStatusMessage: (message: string) => void;
}


export function createOpenDetachedGenericWindow(controllerContext: OpenDetachedGenericWindowContext): <T>(kind: DetachedKind, sourceTabId: string, detachedId: string, payload: T, title: string) => void {
  return <T,>(
      kind: DetachedKind,
      sourceTabId: string,
      detachedId: string,
      payload: T,
      title: string,
    ) => {
      writeGenericHandoff(kind, detachedId, payload);
      if (isTauriRuntime()) {
        void openDetachedWindow({
          kind,
          sessionId: detachedId,
          title,
        })
          .then(() => {
            // Once the OS window is up the source tab is no longer the
            // owner of this connection. Drop it; the detached window owns
            // a fresh connection of its own.
            controllerContext.removeTab(sourceTabId);
          })
          .catch((err) => {
            clearGenericHandoff(kind, detachedId);
            if (kind === "terminal") clearTerminalDetachPending(sourceTabId);
            controllerContext.setStatusMessage(
              tr("status.detachWindowError", {
                error: err instanceof Error ? err.message : String(err),
              }),
            );
          });
        return;
      }
      const url = detachedGenericUrl(kind, detachedId);
      const features = "width=1280,height=800,resizable=yes,scrollbars=yes";
      const handle = window.open(url, `taomni_${kind}_${detachedId}`, features);
      if (!handle) {
        clearGenericHandoff(kind, detachedId);
        if (kind === "terminal") clearTerminalDetachPending(sourceTabId);
        controllerContext.setStatusMessage(tr("status.detachPopupBlocked"));
        return;
      }
      controllerContext.removeTab(sourceTabId);
    };
}



export interface OpenDetachedRdpContext {
  openDetachedGenericWindow: <T>(kind: DetachedKind, sourceTabId: string, detachedId: string, payload: T, title: string) => void;
}


export function createOpenDetachedRdp(controllerContext: OpenDetachedRdpContext): (tabId: string, info: NonNullable<Tab["rdp"]>, title: string) => void {
  return (tabId: string, info: NonNullable<Tab["rdp"]>, title: string) => {
      const detachedId = `${tabId}__detached`;
      const payload: DetachedRdpParams = {
        tabId,
        sessionId: info.sessionId,
        host: info.host,
        port: info.port,
        username: info.username ?? null,
        password: info.password,
        options: info.options,
        networkSettingsJson: info.networkSettingsJson ?? null,
        title,
      };
      controllerContext.openDetachedGenericWindow("rdp", tabId, detachedId, payload, title);
    };
}



export interface OpenDetachedVncContext {
  openDetachedGenericWindow: <T>(kind: DetachedKind, sourceTabId: string, detachedId: string, payload: T, title: string) => void;
  setStatusMessage: (message: string) => void;
}


export function createOpenDetachedVnc(controllerContext: OpenDetachedVncContext): (tabId: string, info: NonNullable<Tab["vnc"]>, title: string) => void {
  return (tabId: string, info: NonNullable<Tab["vnc"]>, title: string) => {
      const detachedId = `${tabId}__detached`;
      void vncCreateDetachClaim({
        host: info.host,
        port: info.port,
        username: info.username ?? null,
        password: info.password,
        network_settings_json: info.networkSettingsJson ?? null,
        security_policy: info.securityPolicy ?? "prefer-encryption",
        view_only: info.viewOnly ?? false,
        clipboard_policy: info.clipboardPolicy ?? "bidirectional",
        viewer_options_json: info.viewerOptions ? serializeVncViewerOptions(info.viewerOptions) : null,
      }).then((claimId) => {
        // The browser-persisted handoff contains only an opaque one-time id;
        // password/proxy secrets stay in backend memory.
        const payload = redactVncHandoff<DetachedVncParams>({
          tabId,
          sessionId: info.sessionId,
          host: info.host,
          port: info.port,
          username: info.username,
          networkSettingsJson: info.networkSettingsJson,
          title,
        }, claimId);
        controllerContext.openDetachedGenericWindow("vnc", tabId, detachedId, payload, title);
      }).catch((error) => {
        controllerContext.setStatusMessage(error instanceof Error ? error.message : String(error));
      });
    };
}



export interface OpenDetachedTerminalContext {
  terminalSessionIds: import("react").RefObject<Record<string, string>>;
  terminalProfileOverrides: Record<string, TerminalProfile>;
  terminalProfilesBySessionId: Map<string, TerminalProfile | undefined>;
  openDetachedGenericWindow: <T>(kind: DetachedKind, sourceTabId: string, detachedId: string, payload: T, title: string) => void;
}


export function createOpenDetachedTerminal(controllerContext: OpenDetachedTerminalContext): (tabId: string, tab: Tab, title: string) => void {
  return (
      tabId: string,
      tab: Tab,
      title: string,
    ) => {
      // Capture the live backend session id + scrollback snapshot so the
      // detached window can adopt the existing PTY/SSH session instead of
      // spawning a fresh one. The TerminalPanel cleanup on the source tab
      // honours the detach-pending flag and skips its `closeTerminal`
      // call so the backend session survives the React unmount.
      const detachedId = `${tabId}__detached`;
      const liveSessionId = controllerContext.terminalSessionIds.current[tabId];
      const liveEntry = getTerminal(tabId);
      const snapshotText = liveEntry ? liveEntry.getBufferText() : undefined;
      const reattach = liveSessionId
        ? { terminalSessionId: liveSessionId, snapshotText }
        : undefined;
      const terminalProfile = controllerContext.terminalProfileOverrides[tabId]
        ?? (tab.sessionId ? controllerContext.terminalProfilesBySessionId.get(tab.sessionId) : undefined)
        ?? tab.terminalProfile
        ?? null;
      const payload: DetachedTerminalParams = {
        tabId,
        title,
        terminalTitleMode: tab.terminalTitleMode,
        terminalTitleOperation: tab.terminalTitleOperation,
        terminalTitleSessionName: tab.terminalTitleSessionName,
        ssh: tab.ssh ?? null,
        commandTerminal: tab.commandTerminal ?? null,
        localShell: tab.localShell ?? null,
        terminalProfile,
        reattach,
      };
      if (liveSessionId) {
        markTerminalDetachPending(tabId);
      }
      try {
        controllerContext.openDetachedGenericWindow("terminal", tabId, detachedId, payload, title);
      } catch (err) {
        clearTerminalDetachPending(tabId);
        throw err;
      }
    };
}



export interface OpenDetachedDatabaseContext {
  openDetachedGenericWindow: <T>(kind: DetachedKind, sourceTabId: string, detachedId: string, payload: T, title: string) => void;
}


export function createOpenDetachedDatabase(controllerContext: OpenDetachedDatabaseContext): (tabId: string, info: NonNullable<Tab["db"]>, title: string) => void {
  return (tabId: string, info: NonNullable<Tab["db"]>, title: string) => {
      const detachedId = `${tabId}__detached`;
      const payload: DetachedDbParams = {
        tabId,
        title,
        // Give the detached window its own connection handle so the source
        // tab's unmount disconnect cannot race and close the detached query
        // workspace connection.
        info: {
          ...info,
          sessionId: detachedId,
          workspaceSessionId: info.workspaceSessionId ?? info.sessionId,
        },
      };
      controllerContext.openDetachedGenericWindow("database", tabId, detachedId, payload, title);
    };
}



export interface HandleDetachActiveTabContext {
  openDetachedTerminal: (tabId: string, tab: Tab, title: string) => void;
  openDetachedRdp: (tabId: string, info: NonNullable<Tab["rdp"]>, title: string) => void;
  openDetachedVnc: (tabId: string, info: NonNullable<Tab["vnc"]>, title: string) => void;
  openDetachedDatabase: (tabId: string, info: NonNullable<Tab["db"]>, title: string) => void;
  openDetachedSftp: (params: SftpTabInfo, title: string) => void;
}


export function createHandleDetachActiveTab(controllerContext: HandleDetachActiveTabContext): () => void {
  return () => {
    const state = useAppStore.getState();
    const tab = state.tabs.find((item) => item.id === state.activeTabId);
    if (!tab) return;
    if (tab.type === "terminal" && !state.terminalSplitActive) {
      controllerContext.openDetachedTerminal(tab.id, tab, tab.title);
    } else if (tab.type === "rdp" && tab.rdp) {
      controllerContext.openDetachedRdp(tab.id, tab.rdp, tab.title);
    } else if (tab.type === "vnc" && tab.vnc) {
      controllerContext.openDetachedVnc(tab.id, tab.vnc, tab.title);
    } else if (tab.type === "database" && tab.db) {
      controllerContext.openDetachedDatabase(tab.id, tab.db, tab.title);
    } else if (tab.type === "sftp" && tab.sftp) {
      controllerContext.openDetachedSftp(tab.sftp, tab.title);
    }
  };
}
