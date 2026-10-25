import { open as tauriOpen } from "@tauri-apps/plugin-shell";
import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { Terminal } from "@xterm/xterm";
import { closeTerminal, createTerminalSessionId, recordLocalDirectoryUse, submitSshAuthResponse } from "../../../lib/ipc";
import { isTauriRuntime } from "../../../lib/runtime";
import { sockscapStopLaunchedApp } from "../../../lib/sockscap";
import { getDefaultTerminalFontFamily, getPrimaryFontName, isMonospaceFont } from "../../../lib/systemFonts";
import { consumeTerminalDetachPending } from "../../../lib/terminal/terminalRegistry";
import { attachTerminalImeGuard, shouldUseLinuxImeGuard, TerminalImeInputGuard } from "../../../lib/terminalImeGuard";
import { createTaskExitOscParser } from "../../../lib/terminalOutputFilter";
import { connectTerminalBackend } from "./backendConnection";
import { collectBufferMatches, getBufferText, terminalAtIdlePrompt } from "./buffer";
import { ERASE_SAVED_LINES_SEQUENCE } from "./policy";
import { installTerminalComposition } from "./sessionComposition";
import type { TerminalSessionLifetime } from "./sessionContracts";
import { type TerminalSessionLifecycleContext } from "./sessionContracts";
import { installTerminalShellProtocols } from "./sessionProtocols";
import { createTerminalTransfer } from "./sessionTransfer";

export function createTerminalSessionLifecycle(controllerContext: TerminalSessionLifecycleContext): import("react").EffectCallback {
  return () => setupTerminalSession(controllerContext);
}

function setupTerminalSession(controllerContext: TerminalSessionLifecycleContext) {
  const { ssh, sockscapTerminal } = controllerContext;
  const el = controllerContext.containerRef.current;
  if (!el || controllerContext.initializedRef.current) return;

  controllerContext.initializedRef.current = true;
  const lifetime: TerminalSessionLifetime = {
    destroyed: false,
    unlistenExit: null,
    unlistenForwardError: null,
    unlistenAuthPrompt: null,
    detachImeGuard: null,
    cleanupImePositionLock: null,
    resizeTimer: undefined,
    activityPromptTimer: undefined,
    sshLaunchTimer: undefined,
    sockscapLaunchTimer: undefined,
    launchedSockscapPid: null,
  };

  controllerContext.automationInputSettlingRef.current = Boolean(ssh && !controllerContext.adoptedTerminalRef.current);

  const submitLocalDirectoryUse = (path: string) => {
    const backendSessionId = controllerContext.sessionIdRef.current;
    if (!backendSessionId) {
      controllerContext.pendingLocalDirectoryReportsRef.current.push(path);
      return;
    }
    recordLocalDirectoryUse({ backendSessionId, path }).catch(
      (error) => {
        console.warn("Local directory use record failed:", error);
      },
    );
  };

  const flushPendingLocalDirectoryReports = (backendSessionId: string) => {
    const pending = controllerContext.pendingLocalDirectoryReportsRef.current.splice(0);
    for (const path of pending) {
      recordLocalDirectoryUse({ backendSessionId, path }).catch(
        (error) => {
          console.warn("Local directory use record failed:", error);
        },
      );
    }
  };

  const primaryFont = getPrimaryFontName(controllerContext.fontFamily);
  const safeFontFamily = isMonospaceFont(primaryFont) ? controllerContext.fontFamily : getDefaultTerminalFontFamily();

  const term = new Terminal({
    allowTransparency: true,
    theme: controllerContext.resolvePanelTheme(controllerContext.themeName),
    fontFamily: safeFontFamily,
    fontSize: controllerContext.fontSize,
    cursorBlink: controllerContext.cursorBlink,
    cursorStyle: controllerContext.cursorStyle,
    scrollback: controllerContext.scrollback,
    macOptionIsMeta: false,
  });
  controllerContext.termRef.current = term;
  const taskExitOscParser = createTaskExitOscParser();
  // Some PTY/WebView combinations render CSI 3 J visually but leave the
  // old normal-buffer row in xterm's scrollback model. Keep the mirrored
  // text in sync with the visible terminal by clearing the active buffer
  // immediately before xterm consumes that explicit erase-saved-lines
  // sequence. This is a four-byte state machine so split output chunks do
  // not require decoding or copying the full output stream.
  let eraseSavedLinesMatch = 0;
  const sawEraseSavedLines = (bytes: Uint8Array): boolean => {
    for (const byte of bytes) {
      if (byte === ERASE_SAVED_LINES_SEQUENCE[eraseSavedLinesMatch]) {
        eraseSavedLinesMatch += 1;
        if (eraseSavedLinesMatch === ERASE_SAVED_LINES_SEQUENCE.length) {
          eraseSavedLinesMatch = 0;
          return true;
        }
      } else {
        eraseSavedLinesMatch = byte === ERASE_SAVED_LINES_SEQUENCE[0] ? 1 : 0;
      }
    }
    return false;
  };

  const fitAddon = new FitAddon();
  controllerContext.fitAddonRef.current = fitAddon;
  term.loadAddon(fitAddon);

  const searchAddon = new SearchAddon();
  controllerContext.searchAddonRef.current = searchAddon;
  term.loadAddon(searchAddon);
  term.loadAddon(
    new WebLinksAddon((_event, uri) => {
      if (isTauriRuntime()) {
        tauriOpen(uri).catch((err) => {
          console.error("Failed to open terminal link in system browser:", err);
        });
      } else {
        const newWindow = window.open(uri, "_blank", "noopener,noreferrer");
        if (newWindow) {
          newWindow.opener = null;
        }
      }
    })
  );
  term.open(el);
  installTerminalComposition({
    term,
    controllerContext,
    el,
    lifetime,
  });
  installTerminalShellProtocols({
    term,
    controllerContext,
    submitLocalDirectoryUse,
  });

  if (shouldUseLinuxImeGuard()) {
    // Linux WebKitGTK can forward IME preedit text through xterm before the final commit.
    const guard = new TerminalImeInputGuard({ commit: controllerContext.sendTerminalInput });
    controllerContext.imeGuardRef.current = guard;
    lifetime.detachImeGuard = attachTerminalImeGuard(el, guard);
  }

  controllerContext.installTerminalWebgl(term);

  controllerContext.fitVisibleTerminal();

  term.onData(controllerContext.writeXtermInput);
  term.onBinary(controllerContext.writeBinaryInput);
  term.attachCustomKeyEventHandler((event) => {
    if (event.type !== "keydown") return true;
    return controllerContext.handleShortcutKey(event);
  });
  const selectionDisposable = term.onSelectionChange(() => {
    if (controllerContext.blockSelectionRef.current) return;
    if (controllerContext.copyOnSelectRef.current && term.hasSelection()) {
      void controllerContext.writeClipboardText(term.getSelection(), "");
    }

    // SelectionToolbar: show when there is a non-empty selection that
    // contains useful content (ignore single-char accidental drags).
    if (term.hasSelection()) {
      const text = term.getSelection();
      controllerContext.showTerminalSelectionToolbar(text);
    } else {
      controllerContext.setSelectionToolbar(null);
    }
  });
  const scrollDisposable = term.onScroll(() => controllerContext.setViewportVersion((v) => v + 1));
  const syncAutomationState = () => {
    const panel = controllerContext.panelRef.current;
    if (!panel) return;
    // Output callbacks can run before xterm has committed the final prompt
    // row. Re-check the deferred installer from the same readiness poll so
    // startup commands and cwd setup cannot be stranded by that ordering.
    if (
      controllerContext.connectionStateRef.current === "connected"
      && terminalAtIdlePrompt(term)
      && controllerContext.installSshCwdIntegrationRef.current
    ) {
      controllerContext.installSshCwdIntegrationRef.current();
    }
    // Only the observation copy is optional. Keep CWD installation, prompt
    // readiness and the poll lifecycle active in every compilation mode.
    if (__TAOMNI_TERMINAL_TEXT_MIRROR__) {
      panel.setAttribute("data-terminal-text", getBufferText(term));
    }
    if (
      controllerContext.connectionStateRef.current === "connected" &&
      !controllerContext.automationInputSettlingRef.current &&
      terminalAtIdlePrompt(term)
    ) {
      panel.setAttribute("data-terminal-ready", "true");
    } else {
      panel.removeAttribute("data-terminal-ready");
    }
  };
  syncAutomationState();
  const automationStateTimer = window.setInterval(syncAutomationState, 500);
  const renderDisposable = term.onRender(() => {
    controllerContext.setViewportVersion((v) => v + 1);
    syncAutomationState();
  });
  const resizeDisposable = term.onResize(({ cols, rows }) => {
    const { query, index } = controllerContext.fallbackSearchRef.current;
    if (controllerContext.searchInputRef.current && query && index >= 0) {
      // xterm reflows the buffer when column count changes. Keep the same
      // match ordinal, but refresh its coordinates without selecting over
      // a user's current drag/block selection or navigating to a new hit.
      const matches = collectBufferMatches(term, query);
      const nextIndex = Math.min(index, matches.length - 1);
      controllerContext.fallbackSearchRef.current = { query, index: nextIndex };
      controllerContext.setSearchMatches(matches);
      controllerContext.setActiveSearchIndex(nextIndex);
      controllerContext.setSearchStatus(nextIndex >= 0 ? `Match ${nextIndex + 1}/${matches.length}` : "No matches");
    }
    controllerContext.setViewportVersion((v) => v + 1);
    controllerContext.appendEvent("resize", `${cols}x${rows}`);
    controllerContext.syncTerminalSize();
  });

  const observer = new ResizeObserver(() => {
    clearTimeout(lifetime.resizeTimer);
    lifetime.resizeTimer = setTimeout(() => {
      controllerContext.fitVisibleTerminal();
    }, 100);
  });
  observer.observe(el);

  // Pin the xterm host container against IME-induced focus scrolling. When a
  // CJK IME composes, xterm moves its focused helper-textarea to the cursor
  // cell and grows it to the preedit width; if the cursor sits near the right
  // edge the caret lands past the viewport and the browser scrolls an ancestor
  // to reveal it, shoving the terminal off-screen (it snaps back on commit, so
  // it visibly oscillates). With `overflow:hidden` this container is now the
  // nearest scroll container, so the focus-scroll lands here — reset it to keep
  // the terminal fixed. The terminal's own scrollback lives on `.xterm-viewport`
  // (a different element), so this never touches the user's scroll position.
  // Guarded against the self-recursion of writing scrollLeft inside `scroll`.
  const onContainerScroll = () => {
    if (el.scrollLeft !== 0) el.scrollLeft = 0;
    if (el.scrollTop !== 0) el.scrollTop = 0;
  };
  el.addEventListener("scroll", onContainerScroll, { passive: true });

  const adopted = controllerContext.adoptedTerminalRef.current;
  const sid =
    adopted?.sessionId ??
    sockscapTerminal?.terminalSessionId ??
    createTerminalSessionId();
  if (adopted?.snapshotText) {
    term.write(adopted.snapshotText.replace(/\n/g, "\r\n"));
  }
  const { zmodem } = createTerminalTransfer({
    controllerContext,
    lifetime,
    taskExitOscParser,
    sawEraseSavedLines,
    term,
    syncAutomationState,
  });

  const handleRawOutput = (raw: Uint8Array) => zmodem.consume(raw);
  connectTerminalBackend({
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
  });

  return () => {
    lifetime.destroyed = true;
    lifetime.disposeReconnect?.();
    observer.disconnect();
    el.removeEventListener("scroll", onContainerScroll);
    selectionDisposable.dispose();
    scrollDisposable.dispose();
    renderDisposable.dispose();
    resizeDisposable.dispose();
    clearTimeout(lifetime.resizeTimer);
    window.clearInterval(automationStateTimer);
    if (lifetime.activityPromptTimer) clearTimeout(lifetime.activityPromptTimer);
    if (lifetime.sshLaunchTimer !== undefined) clearTimeout(lifetime.sshLaunchTimer);
    if (lifetime.sockscapLaunchTimer) clearTimeout(lifetime.sockscapLaunchTimer);
    controllerContext.installSshCwdIntegrationRef.current = null;
    controllerContext.automationInputSettlingRef.current = false;
    // Drop (never deliver) keystrokes still held for a hidden setup line.
    const heldInput = controllerContext.injectedInputHoldRef.current;
    if (heldInput.pump !== null) {
      window.clearInterval(heldInput.pump);
      heldInput.pump = null;
    }
    heldInput.queue = [];
    lifetime.unlistenExit?.();
    lifetime.unlistenForwardError?.();
    lifetime.unlistenAuthPrompt?.();
    // Cancel any MFA prompt still awaiting an answer so the backend's auth
    // task stops blocking and tears the half-open connection down.
    if (controllerContext.pendingMfaRequestIdRef.current) {
      void submitSshAuthResponse(controllerContext.pendingMfaRequestIdRef.current, null).catch(() => { });
      controllerContext.pendingMfaRequestIdRef.current = null;
    }
    lifetime.detachImeGuard?.();
    lifetime.cleanupImePositionLock?.();
    if (controllerContext.loggingActiveRef.current && controllerContext.outputLogRef.current) {
      controllerContext.flushRecordedOutput("Terminal closed; saved recorded output");
    }
    if (controllerContext.sessionIdRef.current && !controllerContext.preserveSessionOnUnmountRef.current) {
      const detachPending = controllerContext.tabId ? consumeTerminalDetachPending(controllerContext.tabId) : false;
      // Adopted sessions are owned by whoever originally created them —
      // don't close on unmount, even when StrictMode double-mounts.
      if (!detachPending && !adopted) {
        closeTerminal(controllerContext.sessionIdRef.current).catch(() => { });
      }
    }
    if (lifetime.launchedSockscapPid !== null) {
      void sockscapStopLaunchedApp(lifetime.launchedSockscapPid).catch(() => { });
    }
    term.dispose();
    controllerContext.webglAddonRef.current = null;
    controllerContext.termRef.current = null;
    controllerContext.fitAddonRef.current = null;
    controllerContext.searchAddonRef.current = null;
    controllerContext.sessionIdRef.current = null;
    controllerContext.sdkTaskEnvironmentRef.current = {};
    controllerContext.pendingLocalDirectoryReportsRef.current = [];
    controllerContext.connectionStateRef.current = "idle";
    controllerContext.reconnectSshRef.current = null;
    controllerContext.setRegisteredSessionId(null);
    controllerContext.zmodemRef.current = null;
    controllerContext.imeGuardRef.current = null;
    controllerContext.initializedRef.current = false;
  };
}

export { type TerminalSessionLifecycleContext } from "./sessionContracts";
