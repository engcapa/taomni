import { Terminal } from "@xterm/xterm";
import { writeText as clipboardWriteText } from "../../../lib/clipboard";
import { getAppPlatform } from "../../../lib/runtime";
import { normalizeLocalStartCwd } from "../../../lib/terminalCwd";
import { formatHistoryCdCommand, parseOsc52ClipboardText, parseOsc7 } from "./protocol";
import { type TerminalSessionLifecycleContext } from "./sessionContracts";


export interface InstallTerminalShellProtocolsContext {
  term: Terminal;
  controllerContext: TerminalSessionLifecycleContext;
  submitLocalDirectoryUse: (path: string) => void;
}

export function installTerminalShellProtocols(context: InstallTerminalShellProtocolsContext) {
  const { term, controllerContext, submitLocalDirectoryUse } = context;

  // OSC 7 — host writes its current working directory as `file://host/path`.
  // We listen for this so explicit SFTP "Sync" requests can learn the shell cwd.
  // For local shells we also record absolute path changes into command history
  // so Welcome "Recent folders" works even when the user `cd`s with a relative
  // path (history only stores the typed line, which may not be absolute).
  try {
    term.parser.registerOscHandler(7, (data) => {
      const cwd = parseOsc7(data);
      if (cwd) {
        controllerContext.latestCwdRef.current = cwd;
        controllerContext.cwdCallbackRef.current?.(cwd);
        if (controllerContext.tabId) {
          controllerContext.setTerminalRuntime(controllerContext.tabId, {
            state: "idle",
            program: undefined,
            activitySource: "shell-integration",
          });
        }
        if (controllerContext.isLocalRef.current) {
          const normalized = normalizeLocalStartCwd(cwd, getAppPlatform());
          if (
            normalized
            && normalized !== controllerContext.lastRecordedLocalDirRef.current
          ) {
            controllerContext.lastRecordedLocalDirRef.current = normalized;
            controllerContext.historyRef.current.commit(formatHistoryCdCommand(normalized));
            // Structured confirmed-use report (design §4.1.5): the backend
            // validates the live native-local runtime and dedups per
            // runtime; remote/WSL cwd never reaches this call because
            // normalizeLocalStartCwd returned null for it.
            submitLocalDirectoryUse(normalized);
          }
        }
      }
      return true;
    });
  } catch {
    /* parser API absent in some xterm builds */
  }

  // OSC 133 shell integration is emitted by a number of modern prompts.
  // `A` means prompt start (idle); `C` means command execution start. We do
  // not receive a safe executable name here, so retain any input-derived
  // program label and only improve the lifecycle state.
  try {
    term.parser.registerOscHandler(133, (data) => {
      if (!controllerContext.tabId) return true;
      const marker = data.trim().split(";")[0];
      if (marker === "A") {
        controllerContext.setTerminalRuntime(controllerContext.tabId, {
          state: "idle",
          program: undefined,
          activitySource: "shell-integration",
        });
      } else if (marker === "C") {
        controllerContext.setTerminalRuntime(controllerContext.tabId, {
          state: "running",
          activitySource: "shell-integration",
        });
      }
      return true;
    });
  } catch {
    /* parser API absent in some xterm builds */
  }

  try {
    term.parser.registerOscHandler(52, (data) => {
      const text = parseOsc52ClipboardText(data);
      if (text === null) return true;

      if (!controllerContext.isLocal && !controllerContext.allowRemoteOsc52ClipboardRef.current) {
        controllerContext.setStatusMessage("Remote OSC 52 clipboard is disabled");
        return true;
      }
      if (!text) return true;

      void clipboardWriteText(text)
        .then(() => controllerContext.setStatusMessage("Copied via OSC 52"))
        .catch((err) => {
          controllerContext.setStatusMessage(err instanceof Error ? err.message : "OSC 52 clipboard copy failed");
        });
      return true;
    });
  } catch {
    /* parser API absent in some xterm builds */
  }

  try {
    term.parser.registerOscHandler(633, (data) => {
      const match = /^TaomniTaskExit=(-?\d+)$/.exec(data.trim());
      if (match) controllerContext.onTaskExitRef.current?.(Number.parseInt(match[1], 10));
      return true;
    });
  } catch {
    /* parser API absent in some xterm builds */
  }

}
