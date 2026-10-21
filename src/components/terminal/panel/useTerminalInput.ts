import { useCallback, useRef } from "react";
import { Terminal } from "@xterm/xterm";
import { type TerminalProfile } from "../../../lib/terminalProfile";
import { TerminalImeInputGuard } from "../../../lib/terminalImeGuard";
import { createOsc7BlankingSuppressor, type InputEchoSuppressor } from "../../../lib/terminalOutputFilter";
import { writeTerminal, encodeBase64 } from "../../../lib/ipc";
import { inferTerminalProgram } from "../../../lib/terminalActivity";
import { useChatStore } from "../../../stores/chatStore";
import { type TerminalConnectionState } from "./types";
import { captureBufferCommand } from "./buffer";
import { INJECTED_INPUT_HOLD_MAX_MS, encodeBinaryStringBase64 } from "./protocol";
import { streamInlineAi } from "./inlineAi";

export interface UseTerminalInputContext {
  injectedInputEchoSuppressorRef: import("react").RefObject<InputEchoSuppressor | null>;
  sessionIdRef: import("react").RefObject<string | null>;
  readOnlyRef: import("react").RefObject<boolean>;
  connectionStateRef: import("react").RefObject<TerminalConnectionState>;
  macroRecordingRef: import("react").RefObject<boolean>;
  macroPlaybackRef: import("react").RefObject<boolean>;
  macroBufferRef: import("react").RefObject<string>;
  ssh: import("./types").SshConnectInfo | undefined;
  setStatusMessage: (message: string) => void;
  tabId: string | undefined;
  setTerminalRuntime: (tabId: string, patch: Partial<import("../../../stores/appStore").TerminalRuntimeInfo> | null) => void;
  trackPending: (data: string) => void;
  multiExecActiveRef: import("react").RefObject<boolean | undefined>;
  onInputBroadcastRef: import("react").RefObject<((data: string) => void) | undefined>;
  imeGuardRef: import("react").RefObject<TerminalImeInputGuard | null>;
  adoptedTerminalRef: import("react").RefObject<import("./types").AdoptedTerminalSession | undefined>;
  reconnectSshRef: import("react").RefObject<(() => void) | null>;
  termRef: import("react").RefObject<Terminal | null>;
  pendingRef: import("react").RefObject<string>;
  isLocalPowerShell: boolean;
  invalidatedRef: import("react").RefObject<boolean>;
  refreshSuggestion: () => void;
  terminalProfile: TerminalProfile | undefined;
  cwdProbeCommandRef: import("react").RefObject<string | null>;
}

export function useTerminalInput(context: UseTerminalInputContext) {
  const {
    injectedInputEchoSuppressorRef,
    sessionIdRef,
    readOnlyRef,
    connectionStateRef,
    macroRecordingRef,
    macroPlaybackRef,
    macroBufferRef,
    ssh,
    setStatusMessage,
    tabId,
    setTerminalRuntime,
    trackPending,
    multiExecActiveRef,
    onInputBroadcastRef,
    imeGuardRef,
    adoptedTerminalRef,
    reconnectSshRef,
    termRef,
    pendingRef,
    isLocalPowerShell,
    invalidatedRef,
    refreshSuggestion,
    terminalProfile,
    cwdProbeCommandRef,
  } = context;

  const writeXtermInputRef = useRef<((data: string) => void) | null>(null);
  const injectedInputHoldRef = useRef<{
    queue: string[];
    pump: number | null;
    expiresAt: number;
    flushing: boolean;
  }>({ queue: [], pump: null, expiresAt: 0, flushing: false });

  const flushInjectedInputHold = useCallback(() => {
    const hold = injectedInputHoldRef.current;
    if (hold.pump !== null) {
      window.clearInterval(hold.pump);
      hold.pump = null;
    }
    hold.expiresAt = 0;
    if (hold.queue.length === 0) return;
    const queued = hold.queue.join("");
    hold.queue = [];
    // Re-enter the normal input path so the interceptor, pending-command
    // tracking, MultiExec broadcast and send all see the held keystrokes in
    // order — without holding them again.
    hold.flushing = true;
    try {
      writeXtermInputRef.current?.(queued);
    } finally {
      hold.flushing = false;
    }
  }, []);

  const holdInjectedInput = useCallback((data: string, inputHoldTimeoutMs: number) => {
    const hold = injectedInputHoldRef.current;
    hold.queue.push(data);
    const expiresAt = Date.now() + Math.max(INJECTED_INPUT_HOLD_MAX_MS, inputHoldTimeoutMs);
    if (hold.pump !== null) {
      hold.expiresAt = Math.max(hold.expiresAt, expiresAt);
      return;
    }
    hold.expiresAt = expiresAt;
    hold.pump = window.setInterval(() => {
      const suppressor = injectedInputEchoSuppressorRef.current;
      // Flush as soon as the injected line's own output proves it landed, or
      // once the bounded hold expires so typing never stalls indefinitely.
      if (!suppressor || suppressor.done || Date.now() >= hold.expiresAt) {
        flushInjectedInputHold();
      }
    }, 100);
  }, [flushInjectedInputHold]);

  const sendTerminalInput = useCallback((data: string) => {
    const sid = sessionIdRef.current;
    if (!sid || readOnlyRef.current || connectionStateRef.current !== "connected") return;
    if (macroRecordingRef.current && !macroPlaybackRef.current) {
      macroBufferRef.current += data;
    }
    writeTerminal(sid, encodeBase64(data)).catch(console.error);
  }, []);

  const writeInput = sendTerminalInput;

  // Broadcast-aware input: used for paste and any injected text so that
  // MultiExec mode forwards the same data to all selected terminals.
  const writeBroadcastInput = useCallback((data: string) => {
    if (readOnlyRef.current) return;
    if (!sessionIdRef.current || connectionStateRef.current !== "connected") {
      if (ssh && connectionStateRef.current === "disconnected") {
        setStatusMessage("SSH disconnected; press Enter to reconnect");
      }
      return;
    }
    if (tabId && /[\r\n]/.test(data)) {
      const program = inferTerminalProgram(data.split(/[\r\n]/).find((line) => line.trim()) ?? "");
      if (program) {
        setTerminalRuntime(tabId, {
          state: "running",
          program,
          activitySource: "input-heuristic",
        });
      }
    }
    trackPending(data);
    if (multiExecActiveRef.current) {
      onInputBroadcastRef.current?.(data);
    }
    sendTerminalInput(data);
  }, [sendTerminalInput, setStatusMessage, setTerminalRuntime, ssh, tabId, trackPending]);

  const writeXtermInput = useCallback((data: string) => {
    if (readOnlyRef.current) return;
    const filtered = imeGuardRef.current?.filterTerminalData(data) ?? data;
    if (filtered === null) {
      return;
    }

    // A hidden setup line (shell integration, cwd probe, task wrapper) is being
    // written into the same pty. Windows OpenSSH/ConPTY interleaves a concurrent
    // keystroke write with it and corrupts both (an unterminated shell line),
    // so hold the keystrokes and flush them once the injected line has landed.
    const activeSuppressor = injectedInputEchoSuppressorRef.current;
    if (!injectedInputHoldRef.current.flushing && activeSuppressor && !activeSuppressor.done) {
      holdInjectedInput(filtered, activeSuppressor.inputHoldTimeoutMs ?? INJECTED_INPUT_HOLD_MAX_MS);
      return;
    }

    if (
      ssh &&
      !adoptedTerminalRef.current &&
      connectionStateRef.current === "disconnected" &&
      (filtered === "\r" || filtered === "\n" || filtered === "\r\n")
    ) {
      reconnectSshRef.current?.();
      return;
    }

    if (connectionStateRef.current !== "connected") {
      if (ssh && connectionStateRef.current === "disconnected") {
        setStatusMessage("SSH disconnected; press Enter to reconnect");
      }
      return;
    }

    // `??` inline interceptor: when the user has typed `?? <question>` and
    // presses Enter on a normal-screen prompt, capture the question and
    // route it to the AI Chat Drawer instead of forwarding to the shell.
    // Disabled in alt-screen mode (vim/less/top), in PowerShell, and during
    // multi-exec broadcast.
    const endsWithEnter = filtered.endsWith("\r") || filtered.endsWith("\n");
    if (endsWithEnter && !multiExecActiveRef.current) {
      const term = termRef.current;
      const altScreen = term?.buffer.active.type === "alternate";
      const candidate = pendingRef.current + filtered.slice(0, filtered.length - 1);
      if (
        !altScreen
        && !isLocalPowerShell
        && candidate.startsWith("?? ")
        && candidate.length > 3
      ) {
        const question = candidate.slice(3).trim();
        // Clear the line on the shell (Ctrl+U wipes back to start in bash/zsh).
        sendTerminalInput("\x15");
        pendingRef.current = "";
        invalidatedRef.current = false;
        refreshSuggestion();

        if (terminalProfile?.aiInlineQqRender) {
          // Plan §8.4 inline path: render AI response directly into the
          // terminal as ANSI-styled lines. We write a header, kick the
          // backend stream, and pipe each token straight into xterm.write.
          const term = termRef.current;
          if (term) {
            void streamInlineAi(term, question);
          }
        } else {
          // Default safe path: route to AI Chat Drawer.
          void useChatStore.getState().attachToComposer(`?? ${question}`);
        }
        return;
      }
    }

    if (endsWithEnter && tabId) {
      const term = termRef.current;
      const submittedChunk = filtered.replace(/[\r\n]+$/g, "");
      const command =
        term && term.buffer.active.type !== "alternate"
          ? captureBufferCommand(term) || `${pendingRef.current}${submittedChunk}`
          : `${pendingRef.current}${submittedChunk}`;
      const program = inferTerminalProgram(command);
      if (program) {
        setTerminalRuntime(tabId, {
          state: "running",
          program,
          activitySource: "input-heuristic",
        });
      }
    }

    trackPending(filtered);
    if (multiExecActiveRef.current) {
      onInputBroadcastRef.current?.(filtered);
    }
    sendTerminalInput(filtered);
  }, [sendTerminalInput, setStatusMessage, setTerminalRuntime, ssh, tabId, trackPending, refreshSuggestion, isLocalPowerShell, terminalProfile?.aiInlineQqRender, holdInjectedInput]);

  writeXtermInputRef.current = writeXtermInput;

  const writeBinaryInput = useCallback((data: string) => {
    const sid = sessionIdRef.current;
    if (!sid || readOnlyRef.current || connectionStateRef.current !== "connected") return;
    if (macroRecordingRef.current && !macroPlaybackRef.current) {
      macroBufferRef.current += data;
    }
    writeTerminal(sid, encodeBinaryStringBase64(data)).catch(console.error);
  }, []);

  const requestTerminalCwd = useCallback(() => {
    const sid = sessionIdRef.current;
    if (!sid) {
      setStatusMessage("Terminal is not ready yet");
      return;
    }
    if (readOnlyRef.current) {
      setStatusMessage("Terminal is read-only");
      return;
    }

    const command = cwdProbeCommandRef.current;
    if (!command) {
      // No way to read the cwd for this shell (e.g. cmd.exe).
      setStatusMessage("This shell can't report its working directory");
      return;
    }

    // Never inject when a command is already typed but not yet run: the probe
    // would be appended to it, corrupting both the probe and the user's input.
    // captureBufferCommand reads the rendered current line, so this is
    // shell-agnostic and covers PowerShell too (where pendingRef isn't tracked).
    const term = termRef.current;
    if (term && captureBufferCommand(term).length > 0) {
      setStatusMessage("Can't read the working directory while a command is typed");
      return;
    }

    // Hide the probe's echo: drop everything until the OSC 7 reply it emits.
    injectedInputEchoSuppressorRef.current = createOsc7BlankingSuppressor();
    writeTerminal(sid, encodeBase64(`${command}\r`)).catch((err) => {
      if (sessionIdRef.current === sid) injectedInputEchoSuppressorRef.current = null;
      setStatusMessage(err instanceof Error ? err.message : "Terminal cwd request failed");
    });
  }, [setStatusMessage]);
  return {
    writeBroadcastInput,
    writeInput,
    sendTerminalInput,
    requestTerminalCwd,
    writeXtermInput,
    writeBinaryInput,
    injectedInputHoldRef,
  };
}
