import { Terminal } from "@xterm/xterm";
import {
  checkFileExists,
  readStreamClose,
  readStreamOpen,
  readStreamRead,
  selectSaveDirectory,
  writeStreamAbort,
  writeStreamAppend,
  writeStreamClose,
  writeStreamOpen,
  writeTerminal,
} from "../../../lib/ipc";
import { createTaskExitOscParser } from "../../../lib/terminalOutputFilter";
import { ZmodemSession, type ConflictAction, type SendConflictAction } from "../../../lib/zmodem";
import { terminalAtIdlePrompt } from "./buffer";
import type { TerminalSessionLifetime } from "./sessionContracts";
import { type TerminalSessionLifecycleContext } from "./sessionContracts";


export interface CreateTerminalTransferContext {
  controllerContext: TerminalSessionLifecycleContext;
  lifetime: TerminalSessionLifetime;
  taskExitOscParser: ReturnType<typeof createTaskExitOscParser>;
  sawEraseSavedLines: (bytes: Uint8Array) => boolean;
  term: Terminal;
  syncAutomationState: () => void;
}

export function createTerminalTransfer(context: CreateTerminalTransferContext) {
  const { controllerContext, lifetime, taskExitOscParser, sawEraseSavedLines, term, syncAutomationState } = context;

  // Create the ZMODEM sentry before invoking the backend. The raw output
  // channel can receive early SSH banners before create*Terminal resolves.
  const zmodem = new ZmodemSession(
    (bytes) => {
      let b64 = "";
      for (let i = 0;i < bytes.length;i++) b64 += String.fromCharCode(bytes[i]);
      const activeSid = controllerContext.sessionIdRef.current;
      if (!activeSid || controllerContext.connectionStateRef.current !== "connected") {
        return Promise.reject(new Error("Terminal is not connected"));
      }
      return writeTerminal(activeSid, btoa(b64)).catch((err) => {
        console.error(err);
        throw err;
      });
    },
    {
      onTerminalData: (data) => {
        if (lifetime.destroyed) return;
        const suppressor = controllerContext.injectedInputEchoSuppressorRef.current;
        let filtered = suppressor ? suppressor.filter(data) : data;
        if (suppressor?.done) controllerContext.injectedInputEchoSuppressorRef.current = null;
        if (filtered.length === 0) return;
        // xterm normally consumes OSC 633, but PTY/WebView combinations can
        // deliver a split marker before the parser handler is ready. Parse
        // the raw stream as a fallback so task plans never wait forever for
        // an exit event that is already visible in the terminal output.
        const taskExit = taskExitOscParser.feed(filtered);
        for (const exitCode of taskExit.exitCodes) controllerContext.onTaskExitRef.current?.(exitCode);
        filtered = taskExit.data;
        if (filtered.length === 0) return;
        if (controllerContext.loggingActiveRef.current) {
          controllerContext.outputLogRef.current += new TextDecoder().decode(filtered);
        }
        controllerContext.onOutputRef.current?.();
        if (controllerContext.isComposingRef.current) {
          controllerContext.compositionBufferRef.current.push(filtered);
        } else {
          if (sawEraseSavedLines(filtered) && term.buffer.active.type === "normal") {
            term.clear();
          }
          term.write(filtered, () => {
            syncAutomationState();
            controllerContext.installSshCwdIntegrationRef.current?.();
            if (lifetime.activityPromptTimer) clearTimeout(lifetime.activityPromptTimer);
            lifetime.activityPromptTimer = setTimeout(() => {
              if (
                !lifetime.destroyed &&
                controllerContext.connectionStateRef.current === "connected" &&
                terminalAtIdlePrompt(term)
              ) {
                if (controllerContext.tabId) {
                  controllerContext.setTerminalRuntime(controllerContext.tabId, {
                    state: "idle",
                    program: undefined,
                    activitySource: "input-heuristic",
                  });
                }
                if (controllerContext.installSshCwdIntegrationRef.current) {
                  controllerContext.installSshCwdIntegrationRef.current();
                } else if (
                  controllerContext.automationInputSettlingRef.current &&
                  !controllerContext.injectedInputEchoSuppressorRef.current
                ) {
                  controllerContext.automationInputSettlingRef.current = false;
                  syncAutomationState();
                }
              }
            }, 120);
          });
        }
      },
      onStateChange: (state, progress) => {
        controllerContext.setZmodemState(state);
        controllerContext.setZmodemProgress(progress ?? null);
      },
      onProgress: (progress) => {
        controllerContext.setZmodemProgress({ ...progress });
      },
      onSelectSaveDir: async () => {
        const dir = await selectSaveDirectory(controllerContext.zmodemSaveDirRef.current);
        if (dir) controllerContext.zmodemSaveDirRef.current = dir;
        return dir;
      },
      onSelectSendFiles: async () => {
        controllerContext.appendEvent("zmodem", "Remote rz requested local files");
        controllerContext.setStatusMessage("Remote rz detected; choose local files to send");
        const files = await controllerContext.selectZmodemSendFiles();
        if (files.length === 0) {
          controllerContext.appendEvent("zmodem", "Send canceled");
          controllerContext.setStatusMessage("ZMODEM send canceled");
          controllerContext.focusTerminal();
          return null;
        }
        const names = files.map((f) => f.name).join(", ");
        controllerContext.setStatusMessage(`Sending ${files.length === 1 ? files[0].name : `${files.length} files (${names})`} via ZMODEM…`);
        controllerContext.focusTerminal();
        return files;
      },
      onCheckFileExists: checkFileExists,
      onFileConflict: (fileName, hasMore) =>
        new Promise<ConflictAction>((resolve) => {
          controllerContext.setConflictDialogState({ fileName, hasMore, mode: "receive", resolve });
        }),
      onSendConflict: (fileName, hasMore) =>
        new Promise<SendConflictAction>((resolve) => {
          controllerContext.setConflictDialogState({
            fileName,
            hasMore,
            mode: "send",
            resolve: resolve as (action: ConflictAction | SendConflictAction) => void,
          });
        }),
      onOpenReadStream: readStreamOpen,
      onReadStream: readStreamRead,
      onCloseReadStream: readStreamClose,
      onOpenWriteStream: writeStreamOpen,
      onAppendWriteStream: writeStreamAppend,
      onCloseWriteStream: writeStreamClose,
      onAbortWriteStream: writeStreamAbort,
      onComplete: (fileName) => {
        controllerContext.appendEvent("zmodem", `Transfer complete: ${fileName}`);
        controllerContext.setStatusMessage(`ZMODEM: ${fileName} transferred`);
        window.setTimeout(controllerContext.focusTerminal, 0);
      },
      onError: (message) => {
        controllerContext.appendEvent("error", `ZMODEM error: ${message}`);
        controllerContext.setStatusMessage(`ZMODEM error: ${message}`);
        window.setTimeout(controllerContext.focusTerminal, 0);
      },
    },
  );
  return { zmodem };
}
