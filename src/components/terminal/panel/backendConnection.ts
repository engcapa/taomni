import { sshStartupCommand } from "../../../lib/sshSessionOptions";
import { readSessionBookmark } from "../../../lib/sessionBookmark";
import { createReconnectPolicy } from "./reconnectPolicy";
import { Terminal } from "@xterm/xterm";
import {
  attachTerminalOutput,
  closeTerminal,
  createCommandTerminal,
  createLocalTerminal,
  createSshTerminal,
  createTerminalSessionId,
  listenSshAuthPrompt,
  listenTerminalExit,
  listenTerminalForwardError,
  submitSshAuthResponse,
} from "../../../lib/ipc";
import { getSessionNetworkSettings, toNetworkSettingsPayload } from "../../../lib/networkSettings";
import { getAppPlatform, isTauriRuntime } from "../../../lib/runtime";
import { sockscapLaunchTerminalApp, sockscapStopLaunchedApp } from "../../../lib/sockscap";
import { consumeTerminalDetachPending } from "../../../lib/terminal/terminalRegistry";
import { normalizeLocalStartCwd } from "../../../lib/terminalCwd";
import { parseSessionOptions } from "../../../lib/terminalProfile";
import { buildLocalZshCwdIntegration, buildSshCwdIntegration } from "../../../lib/terminalShellIntegration";
import { ZmodemSession } from "../../../lib/zmodem";
import { getBufferText } from "./buffer";
import { currentTerminalSize, formatSshInfoBanner } from "./policy";
import { buildSshInitialCwdProbe } from "./protocol";
import type { TerminalSessionLifetime } from "./sessionContracts";
import { type TerminalSessionLifecycleContext } from "./sessionContracts";
import { createTerminalCwdInstaller } from "./sessionCwdIntegration";

export interface ConnectTerminalBackendContext {
  controllerContext: TerminalSessionLifecycleContext;
  lifetime: TerminalSessionLifetime;
  sockscapTerminal: import("../../../types").SocksCapTerminalLaunchInfo | undefined;
  term: Terminal;
  ssh: import("./types").SshConnectInfo | undefined;
  adopted: import("./types").AdoptedTerminalSession | undefined;
  flushPendingLocalDirectoryReports: (backendSessionId: string) => void;
  zmodem: ZmodemSession;
  syncAutomationState: () => void;
  handleRawOutput: (raw: Uint8Array) => void;
  sid: string;
}


export function connectTerminalBackend(context: ConnectTerminalBackendContext) {
  const {
    controllerContext,
    lifetime,
    sockscapTerminal,
    term,
    ssh,
    adopted,
    flushPendingLocalDirectoryReports,
    zmodem,
    syncAutomationState,
    handleRawOutput,
    sid,
  } = context;

  const reconnectPolicy = createReconnectPolicy(Boolean(ssh && readSessionBookmark(ssh.optionsJson).reconnect),
    () => controllerContext.reconnectSshRef.current?.());
  lifetime.disposeReconnect = reconnectPolicy.dispose;
  type ConnectMode = "initial" | "reconnect";
  type ConnectResult = {
    sessionId: string;
    shellId: string | null;
    directoryUseWarning?: string | null;
    taskEnvironment?: Record<string, string>;
  };

  const cancelPendingMfa = () => {
    if (controllerContext.pendingMfaRequestIdRef.current) {
      void submitSshAuthResponse(controllerContext.pendingMfaRequestIdRef.current, null).catch(() => { });
      controllerContext.pendingMfaRequestIdRef.current = null;
    }
    controllerContext.setMfaPrompt(null);
  };

  const clearConnectionListeners = () => {
    lifetime.unlistenExit?.();
    lifetime.unlistenExit = null;
    lifetime.unlistenForwardError?.();
    lifetime.unlistenForwardError = null;
    lifetime.unlistenAuthPrompt?.();
    lifetime.unlistenAuthPrompt = null;
  };

  const registerSshAuthPrompt = (targetSid: string) => {
    // SSH connections may demand a second factor (MFA/OTP) via
    // keyboard-interactive auth. Register before createSshTerminal, because
    // the backend emits prompts before that call resolves.
    void listenSshAuthPrompt(targetSid, (payload) => {
      if (lifetime.destroyed) {
        // Window/panel gone — cancel so the backend stops waiting.
        void submitSshAuthResponse(payload.requestId, null).catch(() => { });
        return;
      }
      controllerContext.pendingMfaRequestIdRef.current = payload.requestId;
      controllerContext.setMfaPrompt(payload);
    })
      .then((un) => {
        if (lifetime.destroyed) {
          un();
        } else {
          lifetime.unlistenAuthPrompt = un;
        }
      })
      .catch(() => {
        /* listener registration failed — connect proceeds; if the server
           demands MFA it'll fail with a clear auth error. */
      });
  };

  const markDisconnected = (endedSid: string) => {
    if (controllerContext.sessionIdRef.current !== endedSid) return;

    if (sockscapTerminal) {
      void closeTerminal(endedSid).catch(() => { });
    }

    clearConnectionListeners();
    controllerContext.connectionStateRef.current = "disconnected";
    controllerContext.automationInputSettlingRef.current = false;
    controllerContext.installSshCwdIntegrationRef.current = null;
    controllerContext.injectedInputEchoSuppressorRef.current = null;
    controllerContext.sessionIdRef.current = null;
    controllerContext.setRegisteredSessionId(null);
    controllerContext.zmodemRef.current = null;
    controllerContext.pendingRef.current = "";
    controllerContext.invalidatedRef.current = false;
    controllerContext.suggestionRef.current = null;
    controllerContext.bumpGhost();
    controllerContext.refreshSuggestion();
    if (controllerContext.tabId) {
      controllerContext.setTerminalRuntime(controllerContext.tabId, {
        state: "disconnected",
        program: undefined,
        backendSessionId: undefined,
      });
    }
    controllerContext.onDetachedStateChangeRef.current?.({ snapshotText: getBufferText(term) });

    reconnectPolicy.disconnected();
    controllerContext.appendEvent("disconnect", "Terminal session ended");
    if (controllerContext.loggingActiveRef.current && controllerContext.outputLogRef.current) {
      controllerContext.flushRecordedOutput("Session ended; saved recorded output");
    }

    if (ssh) {
      term.write("\r\n\x1b[33m[SSH disconnected] Press Enter to reconnect.\x1b[0m\r\n");
      controllerContext.setStatusMessage("SSH disconnected; press Enter to reconnect");
      window.setTimeout(controllerContext.focusTerminal, 0);
    } else {
      term.write("\r\n\x1b[33m[Session ended]\x1b[0m\r\n");
    }
  };

  const handleConnected = async function handleConnected(
    { sessionId: connectedSid, shellId, directoryUseWarning, taskEnvironment }: ConnectResult,
    mode: ConnectMode,
    startupCommand?: string,
  ) {
    if (lifetime.destroyed) {
      const detachPending = controllerContext.tabId ? consumeTerminalDetachPending(controllerContext.tabId) : false;
      // Adopted panels never own the backend session — don't close it on
      // unmount even if it appears we were the only mount. The original
      // detacher / reattacher owns lifecycle.
      if (controllerContext.preserveSessionOnUnmountRef.current || detachPending || adopted) {
        controllerContext.onDetachedStateChangeRef.current?.({ terminalSessionId: connectedSid });
      } else {
        closeTerminal(connectedSid).catch(() => { });
      }
      return;
    }

    controllerContext.connectionStateRef.current = "connected";
    controllerContext.sessionIdRef.current = connectedSid;
    controllerContext.sdkTaskEnvironmentRef.current = taskEnvironment ?? {};
    if (controllerContext.isLocalRef.current) flushPendingLocalDirectoryReports(connectedSid);
    controllerContext.lastTerminalSizeSyncRef.current = null;
    controllerContext.setRegisteredSessionId(connectedSid);
    if (controllerContext.tabId) {
      controllerContext.setTerminalRuntime(controllerContext.tabId, {
        backendSessionId: connectedSid,
        state: "unknown",
        program: undefined,
      });
    }
    controllerContext.zmodemRef.current = zmodem;
    if (shellId) controllerContext.setResolvedLocalShellId(shellId);
    controllerContext.pendingMfaRequestIdRef.current = null;
    controllerContext.setMfaPrompt(null);
    controllerContext.onSessionReadyRef.current?.(connectedSid);
    if (directoryUseWarning) {
      controllerContext.appendEvent("error", directoryUseWarning);
      controllerContext.setStatusMessage(directoryUseWarning);
    }
    controllerContext.onDetachedStateChangeRef.current?.({ terminalSessionId: connectedSid });
    controllerContext.appendEvent(
      "connection",
      `${mode === "reconnect" ? "Reconnected" : adopted ? "Reattached" : "Connected"} (${connectedSid})`,
    );
    controllerContext.scheduleTerminalFitAndSync(true);
    const { scheduleCwdIntegrationInstall } = createTerminalCwdInstaller({
      ssh,
      adopted,
      controllerContext,
      lifetime,
      syncAutomationState,
    });
    if (ssh) {
      if (mode === "reconnect") {
        controllerContext.setStatusMessage("SSH reconnected");
        window.setTimeout(controllerContext.focusTerminal, 0);
        window.dispatchEvent(
          new CustomEvent("taomni:terminal-reconnected", {
            detail: { tabId: controllerContext.tabId },
          }),
        );
      }
      // Install continuous OSC 7 cwd reporting on the remote shell so the tab
      // always knows its working directory — used by SFTP "Sync" and, crucially,
      // by tab duplication (which reads the last-known cwd instead of probing
      // the source terminal, so there's no echo to hide and no half-typed input
      // line to corrupt). When this tab is itself a duplicate carrying the
      // source's cwd, the setup cd's there first (SSH can't set a start dir).
      // Best-effort POSIX (bash/zsh); a non-POSIX remote just errors on the
      // line, which the blanking suppressor hides up to its TTL.
      const skipBrowserWindowsSshIntegration =
        !isTauriRuntime() && getAppPlatform() === "windows";
      if (skipBrowserWindowsSshIntegration) {
        if (controllerContext.initialCwd) {
          scheduleCwdIntegrationInstall(connectedSid, buildSshInitialCwdProbe(controllerContext.initialCwd), startupCommand);
        } else if (startupCommand) {
          scheduleCwdIntegrationInstall(connectedSid, null, startupCommand);
        } else {
          controllerContext.automationInputSettlingRef.current = false;
          controllerContext.installSshCwdIntegrationRef.current = null;
          controllerContext.injectedInputEchoSuppressorRef.current = null;
          syncAutomationState();
        }
      } else {
        scheduleCwdIntegrationInstall(connectedSid, buildSshCwdIntegration(controllerContext.initialCwd), startupCommand);
      }
    } else if (
      !controllerContext.commandTerminal &&
      !adopted &&
      getAppPlatform() === "macos"
    ) {
      // macOS-only: the default local shell is zsh, and the backend's
      // shell_integration.rs installs a bash `PROMPT_COMMAND` that zsh
      // ignores — so a local zsh never reports its cwd and tab-duplication /
      // the git panel have nothing to work with. Inject a zsh `precmd_functions`
      // hook the same way the SSH path does. No-op on bash (already covered by
      // the backend `PROMPT_COMMAND`). Linux/Windows locals are left untouched.
      scheduleCwdIntegrationInstall(connectedSid, buildLocalZshCwdIntegration());
    }

    reconnectPolicy.connected();
    lifetime.unlistenExit = await listenTerminalExit(connectedSid, () => markDisconnected(connectedSid));

    // Surface per-row local-forward errors (parse, bind, accept,
    // direct-tcpip open) in the same event log the user already sees
    // for connection / auth / disconnect events. Also re-broadcast
    // as a window-level CustomEvent keyed by the persisted session
    // config id so an open SessionEditor can show the failure
    // inline next to the offending forward row.
    lifetime.unlistenForwardError = await listenTerminalForwardError(connectedSid, (err) => {
      controllerContext.appendEvent(
        "error",
        `Local forward ${err.local} → ${err.remote}: ${err.message}`,
      );
      if (ssh?.sessionId) {
        window.dispatchEvent(
          new CustomEvent("taomni:forward-error", {
            detail: {
              sessionConfigId: ssh.sessionId,
              local: err.local,
              remote: err.remote,
              message: err.message,
            },
          }),
        );
      }
    });
  };

  const handleConnectFailure = (err: unknown, mode: ConnectMode) => {
    if (lifetime.destroyed) return;
    console.error("Failed to create terminal:", err);
    controllerContext.onSessionLaunchFailedRef.current?.(err);
    cancelPendingMfa();
    controllerContext.connectionStateRef.current = ssh ? "disconnected" : "idle";
    controllerContext.automationInputSettlingRef.current = false;
    controllerContext.installSshCwdIntegrationRef.current = null;
    controllerContext.injectedInputEchoSuppressorRef.current = null;
    controllerContext.sessionIdRef.current = null;
    controllerContext.pendingLocalDirectoryReportsRef.current = [];
    controllerContext.setRegisteredSessionId(null);
    controllerContext.zmodemRef.current = null;
    const message = String(err);
    if (controllerContext.tabId) {
      controllerContext.setTerminalRuntime(controllerContext.tabId, {
        state: "disconnected",
        program: undefined,
        backendSessionId: undefined,
      });
    }
    if (mode === "reconnect") reconnectPolicy.disconnected();
    const label = ssh && mode === "reconnect" ? "Reconnect failed" : "Connection failed";
    controllerContext.appendEvent("error", `${label}: ${message}`);
    if (ssh) {
      term.write(`\r\n\x1b[31m[${label}] ${message}\x1b[0m\r\n\x1b[33mPress Enter to retry.\x1b[0m\r\n`);
      controllerContext.setStatusMessage(`${label}; press Enter to retry`);
      window.setTimeout(controllerContext.focusTerminal, 0);
    } else {
      term.write(`\x1b[31m${label}: ${message}\x1b[0m\r\n`);
    }
  };

  const startSshConnection = (targetSid: string, mode: ConnectMode) => {
    if (!ssh || lifetime.destroyed) return;

    clearConnectionListeners();
    cancelPendingMfa();
    controllerContext.connectionStateRef.current = mode === "reconnect" ? "reconnecting" : "connecting";
    controllerContext.automationInputSettlingRef.current = true;
    controllerContext.installSshCwdIntegrationRef.current = null;
    controllerContext.injectedInputEchoSuppressorRef.current = null;
    if (controllerContext.tabId) controllerContext.setTerminalRuntime(controllerContext.tabId, { state: "connecting", program: undefined });
    controllerContext.sessionIdRef.current = null;
    controllerContext.setRegisteredSessionId(null);
    controllerContext.zmodemRef.current = null;
    registerSshAuthPrompt(targetSid);

    controllerContext.appendEvent(
      "connection",
      `${mode === "reconnect" ? "Reconnecting" : "Connecting"} to ${ssh.username}@${ssh.host}:${ssh.port}`,
    );
    controllerContext.appendEvent("auth", `Using ${ssh.authMethod} authentication`);
    if (mode === "reconnect") {
      term.write(`\r\n\x1b[33m[Reconnecting to ${ssh.username}@${ssh.host}:${ssh.port}...]\x1b[0m\r\n`);
      controllerContext.setStatusMessage("Reconnecting SSH terminal");
    } else {
      term.write(`\x1b[33mConnecting to ${ssh.username}@${ssh.host}:${ssh.port}...\x1b[0m\r\n`);
    }

    controllerContext.fitVisibleTerminal();
    const { cols, rows } = currentTerminalSize(term);

    const ns = getSessionNetworkSettings(ssh.optionsJson);
    const opts = parseSessionOptions(ssh.optionsJson);
    const startupCommand = sshStartupCommand(opts);
    const keepStartupCommandOpen = startupCommand.length > 0 && opts.doNotExit !== false;
    const backendStartupCommand = startupCommand && !keepStartupCommandOpen ? startupCommand : null;
    // The native output channel can deliver the shell's first prompt before
    // createSshTerminal resolves. Keep those bytes ordered after our notice;
    // writing the notice after the prompt moves xterm's cursor to a blank
    // line and strands prompt detection, cwd setup and task readiness.
    let pendingOutput: Uint8Array[] | null = [];
    const receiveOutput = (raw: Uint8Array) => {
      if (lifetime.destroyed) return;
      if (pendingOutput) pendingOutput.push(raw.slice());
      else handleRawOutput(raw);
    };
    const releaseOutput = () => {
      const buffered = pendingOutput;
      pendingOutput = null;
      if (!lifetime.destroyed) buffered?.forEach(handleRawOutput);
    };
    createSshTerminal(
      targetSid,
      ssh.host,
      ssh.port,
      ssh.username,
      ssh.authMethod,
      ssh.authData,
      cols,
      rows,
      JSON.stringify(toNetworkSettingsPayload(ns)),
      receiveOutput,
      // X11 forwarding: enabled per-session (defaults on, matching the
      // SessionEditor default). Trusted mode unless the expert option
      // explicitly opts into untrusted.
      opts.x11 !== false,
      opts.x11Trusted !== false,
      backendStartupCommand,
      keepStartupCommandOpen,
    )
      .then((sessionId) => {
        if (!lifetime.destroyed) {
          term.write(mode === "reconnect"
            ? `\r\n\x1b[32m[Reconnected to ${ssh.username}@${ssh.host}:${ssh.port}]\x1b[0m\r\n`
            : formatSshInfoBanner(ssh));
        }
        releaseOutput();
        return handleConnected(
          { sessionId, shellId: null },
          mode,
          keepStartupCommandOpen ? startupCommand : undefined,
        );
      })
      .catch((err) => {
        releaseOutput();
        handleConnectFailure(err, mode);
      });
  };

  const startCommandTerminal = (targetSid: string) => {
    if (!controllerContext.commandTerminal || adopted || lifetime.destroyed) return;

    clearConnectionListeners();
    controllerContext.connectionStateRef.current = "connecting";
    if (controllerContext.tabId) controllerContext.setTerminalRuntime(controllerContext.tabId, { state: "connecting", program: undefined });
    controllerContext.sessionIdRef.current = null;
    controllerContext.setRegisteredSessionId(null);
    controllerContext.zmodemRef.current = null;

    const endpoint = controllerContext.commandTerminal.kind === "Serial"
      ? controllerContext.commandTerminal.host
      : `${controllerContext.commandTerminal.username ? `${controllerContext.commandTerminal.username}@` : ""}${controllerContext.commandTerminal.host}${controllerContext.commandTerminal.port > 0 ? `:${controllerContext.commandTerminal.port}` : ""
      }`;
    controllerContext.appendEvent("connection", `Starting ${controllerContext.commandTerminal.kind} client for ${endpoint}`);
    term.write(`\x1b[33mStarting ${controllerContext.commandTerminal.kind} client for ${endpoint}...\x1b[0m\r\n`);

    controllerContext.fitVisibleTerminal();
    const { cols, rows } = currentTerminalSize(term);

    createCommandTerminal(
      targetSid,
      controllerContext.commandTerminal.kind,
      controllerContext.commandTerminal.host,
      controllerContext.commandTerminal.port,
      controllerContext.commandTerminal.username,
      controllerContext.commandTerminal.optionsJson ?? null,
      cols,
      rows,
      handleRawOutput,
    )
      .then((sessionId) => handleConnected({ sessionId, shellId: null }, "initial"))
      .catch((err) => handleConnectFailure(err, "initial"));
  };

  controllerContext.reconnectSshRef.current = () => {
    if (!ssh || lifetime.destroyed) return;
    if (controllerContext.connectionStateRef.current !== "disconnected") return;
    reconnectPolicy.started();
    startSshConnection(createTerminalSessionId(), "reconnect");
  };

  if (adopted) {
    controllerContext.connectionStateRef.current = "connecting";
    controllerContext.appendEvent("connection", `Reattaching terminal ${sid}`);
    attachTerminalOutput(sid, handleRawOutput)
      .then(() => handleConnected({ sessionId: sid, shellId: null }, "initial"))
      .catch((err) => handleConnectFailure(err, "initial"));
  } else if (ssh) {
    // StrictMode replays mount effects before the next task. Cancel the
    // discarded mount before it opens a second real remote shell.
    lifetime.sshLaunchTimer = window.setTimeout(() => startSshConnection(sid, "initial"), 0);
  } else if (controllerContext.commandTerminal) {
    startCommandTerminal(sid);
  } else if (sockscapTerminal) {
    controllerContext.connectionStateRef.current = "connecting";
    controllerContext.appendEvent("connection", `Starting ${sockscapTerminal.path} through SocksCap`);
    term.write(
      `\x1b[33mStarting ${sockscapTerminal.path} through SocksCap...\x1b[0m\r\n`,
    );
    controllerContext.fitVisibleTerminal();
    const { cols, rows } = currentTerminalSize(term);
    // React StrictMode intentionally runs mount effects twice in development.
    // Defer the irreversible backend launch so the first setup can be
    // cancelled by its immediate cleanup instead of spawning two commands.
    lifetime.sockscapLaunchTimer = window.setTimeout(() => {
      if (lifetime.destroyed) return;
      sockscapLaunchTerminalApp(
        sid,
        sockscapTerminal.profileId,
        sockscapTerminal.path,
        sockscapTerminal.args,
        sockscapTerminal.launchPreparation ?? {},
        cols,
        rows,
        handleRawOutput,
      )
        .then((launched) => {
          if (lifetime.destroyed) {
            void closeTerminal(sid).catch(() => { });
            void sockscapStopLaunchedApp(launched.pid).catch(() => { });
            return;
          }
          lifetime.launchedSockscapPid = launched.pid;
          return handleConnected({ sessionId: sid, shellId: null }, "initial");
        })
        .catch((err) => {
          if (!lifetime.destroyed) handleConnectFailure(err, "initial");
        });
    }, 0);
  } else {
    controllerContext.connectionStateRef.current = "connecting";
    controllerContext.appendEvent("connection", `Starting ${controllerContext.localShell?.name ?? "local terminal"}`);
    controllerContext.fitVisibleTerminal();
    const { cols, rows } = currentTerminalSize(term);
    // A duplicated terminal carries the source's cwd (from OSC 7). Translate
    // it into a native start directory; skip it if it can't be mapped (e.g. a
    // WSL/MSYS path with no Windows drive) so the shell still launches.
    const startCwd = controllerContext.initialCwd
      ? normalizeLocalStartCwd(controllerContext.initialCwd, getAppPlatform()) ?? undefined
      : undefined;
    createLocalTerminal(
      sid,
      cols,
      rows,
      controllerContext.localShell?.id,
      controllerContext.localShell?.args,
      startCwd,
      handleRawOutput,
      controllerContext.workspaceRootRef.current,
    )
      .then(({ sessionId, shellId, directoryUseWarning, taskEnvironment }) =>
        handleConnected({ sessionId, shellId, directoryUseWarning, taskEnvironment }, "initial"),
      )
      .catch((err) => handleConnectFailure(err, "initial"));
  }

}
