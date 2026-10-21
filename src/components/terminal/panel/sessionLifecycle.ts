import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { parseSessionOptions } from "../../../lib/terminalProfile";
import { getSessionNetworkSettings, toNetworkSettingsPayload } from "../../../lib/networkSettings";
import { getDefaultTerminalFontFamily, getPrimaryFontName, isMonospaceFont } from "../../../lib/systemFonts";
import { attachTerminalImeGuard, shouldUseLinuxImeGuard, TerminalImeInputGuard } from "../../../lib/terminalImeGuard";
import { shouldSuppressMacImeKeydown, clearStaleKeyDownSeen, clearStaleKeyDownSeenIfActive } from "../../../lib/terminal/macImeKeydown";
import { writeText as clipboardWriteText } from "../../../lib/clipboard";
import { createOscMarkerBlankingSuppressor, createOsc7BlankingSuppressor, createTaskExitOscParser, type InputEchoSuppressor } from "../../../lib/terminalOutputFilter";
import { createTerminalSessionId, attachTerminalOutput, createCommandTerminal, createLocalTerminal, createSshTerminal, recordLocalDirectoryUse, listenSshAuthPrompt, submitSshAuthResponse, type SshAuthPromptPayload, writeTerminal, closeTerminal, listenTerminalExit, listenTerminalForwardError, encodeBase64, selectSaveDirectory, readStreamOpen, readStreamRead, readStreamClose, writeStreamOpen, writeStreamAppend, writeStreamClose, writeStreamAbort, checkFileExists } from "../../../lib/ipc";
import { getAppPlatform, isTauriRuntime } from "../../../lib/runtime";
import { normalizeLocalStartCwd } from "../../../lib/terminalCwd";
import { buildSshCwdIntegration, buildLocalZshCwdIntegration, CWD_INTEGRATION_DONE_MARKER } from "../../../lib/terminalShellIntegration";
import { consumeTerminalDetachPending } from "../../../lib/terminal/terminalRegistry";
import { ZmodemSession, type ZmodemState, type ZmodemProgress, type ZmodemSendFile, type ConflictAction, type SendConflictAction } from "../../../lib/zmodem";
import { type UnlistenFn } from "@tauri-apps/api/event";
import { open as tauriOpen } from "@tauri-apps/plugin-shell";
import { sockscapLaunchTerminalApp, sockscapStopLaunchedApp } from "../../../lib/sockscap";
import { type TerminalConnectionState, type TerminalBlockSelection, type SearchMatch, type TerminalReattachState } from "./types";
import { currentTerminalSize, ERASE_SAVED_LINES_SEQUENCE, formatSshInfoBanner } from "./policy";
import { getBufferText, getLastBufferLines, terminalAtIdlePrompt, collectBufferMatches } from "./buffer";
import { CWD_QUERY_COMMAND, parseOsc7, formatHistoryCdCommand, parseOsc52ClipboardText, buildSshInitialCwdProbe, CWD_SETUP_INPUT_HOLD_MAX_MS } from "./protocol";


export interface TerminalSessionLifecycleContext {
  containerRef: import("react").RefObject<HTMLDivElement | null>;
  initializedRef: import("react").RefObject<boolean>;
  automationInputSettlingRef: import("react").RefObject<boolean>;
  ssh: import("./types").SshConnectInfo | undefined;
  adoptedTerminalRef: import("react").RefObject<import("./types").AdoptedTerminalSession | undefined>;
  sessionIdRef: import("react").RefObject<string | null>;
  pendingLocalDirectoryReportsRef: import("react").RefObject<string[]>;
  fontFamily: string;
  resolvePanelTheme: (name: string) => import("@xterm/xterm").ITheme;
  themeName: string;
  fontSize: number;
  cursorBlink: boolean;
  cursorStyle: "block" | "underline" | "bar";
  scrollback: number;
  termRef: import("react").RefObject<Terminal | null>;
  fitAddonRef: import("react").RefObject<FitAddon | null>;
  searchAddonRef: import("react").RefObject<SearchAddon | null>;
  isComposingRef: import("react").RefObject<boolean>;
  compositionBufferRef: import("react").RefObject<Uint8Array<ArrayBufferLike>[]>;
  isMac: boolean;
  latestCwdRef: import("react").RefObject<string | null>;
  cwdCallbackRef: import("react").RefObject<((cwd: string) => void) | undefined>;
  tabId: string | undefined;
  setTerminalRuntime: (tabId: string, patch: Partial<import("../../../stores/appStore").TerminalRuntimeInfo> | null) => void;
  isLocalRef: import("react").RefObject<boolean>;
  lastRecordedLocalDirRef: import("react").RefObject<string | null>;
  historyRef: import("react").RefObject<import("../../../lib/history").CommandHistory>;
  isLocal: boolean;
  allowRemoteOsc52ClipboardRef: import("react").RefObject<boolean>;
  setStatusMessage: (message: string) => void;
  onTaskExitRef: import("react").RefObject<((exitCode: number) => void) | undefined>;
  sendTerminalInput: (data: string) => void;
  imeGuardRef: import("react").RefObject<TerminalImeInputGuard | null>;
  installTerminalWebgl: (term: Terminal) => void;
  fitVisibleTerminal: (forceSync?: boolean) => void;
  writeXtermInput: (data: string) => void;
  writeBinaryInput: (data: string) => void;
  handleShortcutKey: (event: KeyboardEvent) => boolean;
  blockSelectionRef: import("react").RefObject<TerminalBlockSelection | null>;
  copyOnSelectRef: import("react").RefObject<boolean>;
  writeClipboardText: (text: string, successMessage: string) => Promise<void>;
  showTerminalSelectionToolbar: (text: string) => void;
  setSelectionToolbar: import("react").Dispatch<import("react").SetStateAction<{ rect: { top: number; left: number; right: number; bottom: number; }; text: string; } | null>>;
  setViewportVersion: import("react").Dispatch<import("react").SetStateAction<number>>;
  panelRef: import("react").RefObject<HTMLDivElement | null>;
  connectionStateRef: import("react").RefObject<TerminalConnectionState>;
  installSshCwdIntegrationRef: import("react").RefObject<(() => boolean) | null>;
  fallbackSearchRef: import("react").RefObject<{ query: string; index: number; }>;
  searchInputRef: import("react").RefObject<HTMLInputElement | null>;
  setSearchMatches: import("react").Dispatch<import("react").SetStateAction<SearchMatch[]>>;
  setActiveSearchIndex: import("react").Dispatch<import("react").SetStateAction<number>>;
  setSearchStatus: import("react").Dispatch<import("react").SetStateAction<string>>;
  appendEvent: (type: string, detail: string) => void;
  syncTerminalSize: (force?: boolean) => void;
  sockscapTerminal: import("../../../types").SocksCapTerminalLaunchInfo | undefined;
  injectedInputEchoSuppressorRef: import("react").RefObject<InputEchoSuppressor | null>;
  loggingActiveRef: import("react").RefObject<boolean>;
  outputLogRef: import("react").RefObject<string>;
  onOutputRef: import("react").RefObject<(() => void) | undefined>;
  setZmodemState: import("react").Dispatch<import("react").SetStateAction<ZmodemState>>;
  setZmodemProgress: import("react").Dispatch<import("react").SetStateAction<ZmodemProgress | null>>;
  zmodemSaveDirRef: import("react").RefObject<string | undefined>;
  selectZmodemSendFiles: () => Promise<ZmodemSendFile[]>;
  focusTerminal: () => void;
  setConflictDialogState: import("react").Dispatch<import("react").SetStateAction<{ fileName: string; hasMore: boolean; mode: "receive" | "send"; resolve: (action: ConflictAction | SendConflictAction) => void; } | null>>;
  pendingMfaRequestIdRef: import("react").RefObject<string | null>;
  setMfaPrompt: import("react").Dispatch<import("react").SetStateAction<SshAuthPromptPayload | null>>;
  setRegisteredSessionId: import("react").Dispatch<import("react").SetStateAction<string | null>>;
  zmodemRef: import("react").RefObject<ZmodemSession | null>;
  pendingRef: import("react").RefObject<string>;
  invalidatedRef: import("react").RefObject<boolean>;
  suggestionRef: import("react").RefObject<string | null>;
  bumpGhost: () => void;
  refreshSuggestion: () => void;
  onDetachedStateChangeRef: import("react").RefObject<((state: TerminalReattachState) => void) | undefined>;
  flushRecordedOutput: (reason: string) => void;
  preserveSessionOnUnmountRef: import("react").RefObject<boolean>;
  sdkTaskEnvironmentRef: import("react").RefObject<Record<string, string>>;
  lastTerminalSizeSyncRef: import("react").RefObject<{ sessionId: string; cols: number; rows: number; } | null>;
  setResolvedLocalShellId: import("react").Dispatch<import("react").SetStateAction<string | null>>;
  onSessionReadyRef: import("react").RefObject<((sessionId: string) => void) | undefined>;
  scheduleTerminalFitAndSync: (forceSync?: boolean) => void;
  initialCwd: string | undefined;
  commandTerminal: import("./types").CommandTerminalConnectInfo | undefined;
  onSessionLaunchFailedRef: import("react").RefObject<((error: unknown) => void) | undefined>;
  reconnectSshRef: import("react").RefObject<(() => void) | null>;
  localShell: { id: string; name: string; args?: string[]; } | undefined;
  workspaceRootRef: import("react").RefObject<string | undefined>;
  injectedInputHoldRef: import("react").RefObject<{ queue: string[]; pump: number | null; expiresAt: number; flushing: boolean; }>;
  webglAddonRef: import("react").RefObject<{ addon: import("@xterm/addon-webgl").WebglAddon; contextLossDisposable: { dispose: () => void; } | null; } | null>;
}


export function createTerminalSessionLifecycle(controllerContext: TerminalSessionLifecycleContext): import("react").EffectCallback {
  return () => {
    const { ssh, sockscapTerminal } = controllerContext;
    const el = controllerContext.containerRef.current;
    if (!el || controllerContext.initializedRef.current) return;

    controllerContext.initializedRef.current = true;

    let destroyed = false;
    let unlistenExit: UnlistenFn | null = null;
    let unlistenForwardError: UnlistenFn | null = null;
    let unlistenAuthPrompt: UnlistenFn | null = null;
    let detachImeGuard: (() => void) | null = null;
    let cleanupImePositionLock: (() => void) | null = null;
    let resizeTimer: ReturnType<typeof setTimeout>;
    let activityPromptTimer: ReturnType<typeof setTimeout> | undefined;
    let sshLaunchTimer: ReturnType<typeof setTimeout> | undefined;
    let sockscapLaunchTimer: ReturnType<typeof setTimeout> | undefined;
    let launchedSockscapPid: number | null = null;

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

    // Lock helper-textarea position during CJK IME composition to prevent candidate box jumping
    // when background text animations (e.g. Claude Code spinners) trigger cursor repositioning.
    const textarea = term.textarea;
    if (textarea) {
      let isComposing = false;
      let lockedLeft = "";
      let lockedTop = "";

      const onCompositionStart = () => {
        controllerContext.isComposingRef.current = true;
        isComposing = true;
        lockedLeft = textarea.style.left;
        lockedTop = textarea.style.top;
      };

      const onCompositionEnd = () => {
        controllerContext.isComposingRef.current = false;
        isComposing = false;
        // Flush any PTY output buffered during composition
        if (controllerContext.compositionBufferRef.current.length > 0) {
          for (const chunk of controllerContext.compositionBufferRef.current) {
            term.write(chunk);
          }
          controllerContext.compositionBufferRef.current = [];
        }
      };

      textarea.addEventListener("compositionstart", onCompositionStart);
      textarea.addEventListener("compositionend", onCompositionEnd);

      // macOS IME first-character fix. macOS IMEs (Sogou/Pinyin…) deliver committed text
      // via `input` (insertText) events but mark every keydown with keyCode 229, arriving
      // input → keydown → keyup. xterm's _keyDown sets `_keyDownSeen` for those, and its
      // _inputEvent then skips a composed character while the flag is set — so the first
      // char typed with a modifier held (e.g. the `@` from Shift+2) is dropped before it
      // reaches the PTY. Swallow keyCode-229 keydowns (capture phase, on the container so
      // it runs before xterm's textarea handler) so the flag is never set; the character
      // still arrives via `input`. Ctrl/Cmd combos pass through so shortcuts keep working.
      // (Linux uses its own guard above; see shouldSuppressMacImeKeydown for details.)
      const onMacImeKeydownCapture = (e: KeyboardEvent) => {
        if (controllerContext.isMac && shouldSuppressMacImeKeydown(e)) e.stopImmediatePropagation();
      };
      el.addEventListener("keydown", onMacImeKeydownCapture, true);

      // Refocus companion (see clearStaleKeyDownSeen): switching app/Space can drop a
      // modifier/arrow keyup on the other window, leaving xterm's `_keyDownSeen` stuck
      // true so the first digit/symbol typed on return is swallowed (letters, which go
      // through IME composition, are unaffected). Clear it whenever the terminal regains
      // focus — no key is actually held at that point.
      const onMacImeFocus = () => {
        if (controllerContext.isMac) clearStaleKeyDownSeen(term as unknown as { _core?: { _keyDownSeen?: boolean } });
      };
      textarea.addEventListener("focus", onMacImeFocus);

      // The textarea-focus reset above only fires when element focus actually
      // changes. A plain app/Space switch (Cmd+Tab, Ctrl+arrow) keeps the textarea
      // as document.activeElement, so it never re-fires `focus` on return and the
      // first digit/symbol is still swallowed (the stray gesture keyup was lost to
      // the window that took focus). The window's `focus` and the document's
      // `visibilitychange` DO fire for those switches — clear the stale flag from
      // there too, guarded to this terminal's textarea so other panes are untouched.
      const onMacImeWindowRefocus = () => {
        if (!controllerContext.isMac || document.visibilityState === "hidden") return;
        clearStaleKeyDownSeenIfActive(
          term as unknown as { textarea?: object | null; _core?: { _keyDownSeen?: boolean } },
          document.activeElement,
        );
      };
      window.addEventListener("focus", onMacImeWindowRefocus);
      document.addEventListener("visibilitychange", onMacImeWindowRefocus);

      const observer = new MutationObserver(() => {
        if (isComposing) {
          observer.disconnect();
          if (textarea.style.left !== lockedLeft) {
            textarea.style.left = lockedLeft;
          }
          if (textarea.style.top !== lockedTop) {
            textarea.style.top = lockedTop;
          }
          observer.observe(textarea, { attributes: true, attributeFilter: ["style"] });
        }
      });

      observer.observe(textarea, { attributes: true, attributeFilter: ["style"] });

      cleanupImePositionLock = () => {
        textarea.removeEventListener("compositionstart", onCompositionStart);
        textarea.removeEventListener("compositionend", onCompositionEnd);
        el.removeEventListener("keydown", onMacImeKeydownCapture, true);
        textarea.removeEventListener("focus", onMacImeFocus);
        window.removeEventListener("focus", onMacImeWindowRefocus);
        document.removeEventListener("visibilitychange", onMacImeWindowRefocus);
        observer.disconnect();
        controllerContext.compositionBufferRef.current = [];
      };
    }

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

    if (shouldUseLinuxImeGuard()) {
      // Linux WebKitGTK can forward IME preedit text through xterm before the final commit.
      const guard = new TerminalImeInputGuard({ commit: controllerContext.sendTerminalInput });
      controllerContext.imeGuardRef.current = guard;
      detachImeGuard = attachTerminalImeGuard(el, guard);
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
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
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

    // Create the ZMODEM sentry before invoking the backend. The raw output
    // channel can receive early SSH banners before create*Terminal resolves.
    const zmodem = new ZmodemSession(
      (bytes) => {
        let b64 = "";
        for (let i = 0; i < bytes.length; i++) b64 += String.fromCharCode(bytes[i]);
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
          if (destroyed) return;
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
              if (activityPromptTimer) clearTimeout(activityPromptTimer);
              activityPromptTimer = setTimeout(() => {
                if (
                  !destroyed &&
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

    const handleRawOutput = (raw: Uint8Array) => zmodem.consume(raw);

    type ConnectMode = "initial" | "reconnect";
    type ConnectResult = {
      sessionId: string;
      shellId: string | null;
      directoryUseWarning?: string | null;
      taskEnvironment?: Record<string, string>;
    };

    const cancelPendingMfa = () => {
      if (controllerContext.pendingMfaRequestIdRef.current) {
        void submitSshAuthResponse(controllerContext.pendingMfaRequestIdRef.current, null).catch(() => {});
        controllerContext.pendingMfaRequestIdRef.current = null;
      }
      controllerContext.setMfaPrompt(null);
    };

    const clearConnectionListeners = () => {
      unlistenExit?.();
      unlistenExit = null;
      unlistenForwardError?.();
      unlistenForwardError = null;
      unlistenAuthPrompt?.();
      unlistenAuthPrompt = null;
    };

    const registerSshAuthPrompt = (targetSid: string) => {
      // SSH connections may demand a second factor (MFA/OTP) via
      // keyboard-interactive auth. Register before createSshTerminal, because
      // the backend emits prompts before that call resolves.
      void listenSshAuthPrompt(targetSid, (payload) => {
        if (destroyed) {
          // Window/panel gone — cancel so the backend stops waiting.
          void submitSshAuthResponse(payload.requestId, null).catch(() => {});
          return;
        }
        controllerContext.pendingMfaRequestIdRef.current = payload.requestId;
        controllerContext.setMfaPrompt(payload);
      })
        .then((un) => {
          if (destroyed) {
            un();
          } else {
            unlistenAuthPrompt = un;
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
        void closeTerminal(endedSid).catch(() => {});
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

      controllerContext.appendEvent("disconnect", "Terminal session ended");
      if (controllerContext.loggingActiveRef.current && controllerContext.outputLogRef.current) {
        controllerContext.flushRecordedOutput("Session ended; saved recorded output");
      }

      if (ssh && !adopted) {
        term.write("\r\n\x1b[33m[SSH disconnected] Press Enter to reconnect.\x1b[0m\r\n");
        controllerContext.setStatusMessage("SSH disconnected; press Enter to reconnect");
        window.setTimeout(controllerContext.focusTerminal, 0);
      } else {
        term.write("\r\n\x1b[33m[Session ended]\x1b[0m\r\n");
      }
    };

    const handleConnected = async (
      { sessionId: connectedSid, shellId, directoryUseWarning, taskEnvironment }: ConnectResult,
      mode: ConnectMode,
      startupCommand?: string,
    ) => {
      if (destroyed) {
        const detachPending = controllerContext.tabId ? consumeTerminalDetachPending(controllerContext.tabId) : false;
        // Adopted panels never own the backend session — don't close it on
        // unmount even if it appears we were the only mount. The original
        // detacher / reattacher owns lifecycle.
        if (controllerContext.preserveSessionOnUnmountRef.current || detachPending || adopted) {
          controllerContext.onDetachedStateChangeRef.current?.({ terminalSessionId: connectedSid });
        } else {
          closeTerminal(connectedSid).catch(() => {});
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
        `${adopted ? "Reattached" : mode === "reconnect" ? "Reconnected" : "Connected"} (${connectedSid})`,
      );
      controllerContext.scheduleTerminalFitAndSync(true);
      // Install continuous OSC 7 cwd reporting by writing a one-shot setup
      // command into the shell, but only once it shows a real, idle prompt —
      // never into a blank/initializing shell (a slow rc / conda init), a
      // streaming MOTD, or a half-typed line. Injecting early is what leaked the
      // raw command: the input got buffered, the echo came back after the
      // suppressor's TTL, and the whole line printed. Poll for the prompt over
      // several seconds; if login init or a startup command outlives that window,
      // retain an event-driven installer that runs when output later settles at
      // an idle prompt. The terminal is usable immediately; this only defers the
      // background hook. Shared by the SSH remote shell and the local macOS zsh.
      const scheduleCwdIntegrationInstall = (
        targetSid: string,
        integrationCommand: string | null,
        pendingStartupCommand?: string,
      ) => {
        if (!integrationCommand && !pendingStartupCommand) return;
        if (ssh && !adopted) controllerContext.automationInputSettlingRef.current = true;
        let integrationAttempts = 0;
        let integrationInstalling = false;
        let startupCommandSent = false;
        let startupCommandOutputObserved = false;
        let startupCommandSentAt = 0;
        let startupCommandPromptSnapshot: string | null = null;
        const snapshotPromptBuffer = (liveTerm: Terminal) => {
          const buffer = liveTerm.buffer.active;
          return `${buffer.baseY + buffer.cursorY}:${buffer.cursorX}\n${getLastBufferLines(liveTerm, 5, buffer.baseY + buffer.cursorY + 1)}`;
        };
        const MAX_INTEGRATION_ATTEMPTS = 12; // ~6s of polling for a slow login
        const installCwdIntegration = (): boolean => {
          if (destroyed || controllerContext.sessionIdRef.current !== targetSid) {
            if (controllerContext.installSshCwdIntegrationRef.current === installCwdIntegration) {
              controllerContext.installSshCwdIntegrationRef.current = null;
            }
            return false;
          }
          if (integrationInstalling) return true;
          const liveTerm = controllerContext.termRef.current;
          if (!liveTerm) return false;
          if (pendingStartupCommand && !startupCommandSent) {
            if (!terminalAtIdlePrompt(liveTerm)) return false;
            startupCommandSent = true;
            startupCommandSentAt = Date.now();
            startupCommandPromptSnapshot = snapshotPromptBuffer(liveTerm);
            writeTerminal(targetSid, encodeBase64(`${pendingStartupCommand}\r`)).catch((err) => {
              controllerContext.appendEvent("error", `Failed to send SSH startup command: ${String(err)}`);
            });
            return false;
          }
          if (pendingStartupCommand && !startupCommandOutputObserved) {
            // xterm updates its buffer as soon as the command is echoed. That
            // echo is not proof that the command completed; sending the cwd
            // hook at that point races the shell and can swallow the startup
            // command on slow SSH/ConPTY sessions. Give the shell a turn, then
            // require an idle prompt and a changed buffer before continuing.
            if (Date.now() - startupCommandSentAt < 500) return false;
            if (snapshotPromptBuffer(liveTerm) === startupCommandPromptSnapshot) return false;
            if (!terminalAtIdlePrompt(liveTerm)) return false;
            startupCommandOutputObserved = true;
            // Keep input held until the following cwd probe also completes.
            // Publishing readiness here exposes a gap between the two writes.
          }
          if (!terminalAtIdlePrompt(liveTerm)) return false;
          if (!integrationCommand) {
            controllerContext.installSshCwdIntegrationRef.current = null;
            controllerContext.automationInputSettlingRef.current = false;
            syncAutomationState();
            return true;
          }
          integrationInstalling = true;
          // xterm allocates blank rows below a short prompt. Inspect the rows
          // ending at the cursor, not the bottom of the viewport.
          const promptBuffer = liveTerm.buffer.active;
          const isMingwShell = /\bMINGW(?:32|64)\b/.test(
            getLastBufferLines(liveTerm, 3, promptBuffer.baseY + promptBuffer.cursorY + 1),
          );
          // Git Bash can take long enough to echo a prompt hook that the user
          // types into the hidden setup line. A one-shot OSC 7 probe still
          // captures the requested cwd without modifying its prompt.
          const useMingwCwdProbe = ssh && isMingwShell && integrationCommand.includes("TaomniCwdIntegrationDone");
          const commandForShell = useMingwCwdProbe
            ? (controllerContext.initialCwd ? buildSshInitialCwdProbe(controllerContext.initialCwd) : CWD_QUERY_COMMAND)
            : integrationCommand;
          const integrationTimeoutMs = isMingwShell && !useMingwCwdProbe ? 30_000 : 4_000;
          const inputHoldTimeoutMs = Math.min(integrationTimeoutMs, CWD_SETUP_INPUT_HOLD_MAX_MS);
          if (controllerContext.installSshCwdIntegrationRef.current === installCwdIntegration) {
            controllerContext.installSshCwdIntegrationRef.current = null;
          }
          // Generous TTL so a laggy link's echo round-trip still arrives while
          // the suppressor is dropping (we only get here at a ready prompt, so
          // it's just network latency, not shell startup). Bounded so a
          // non-POSIX shell — which never emits the OSC 7 — isn't blacked out
          // for too long before output resumes.
          controllerContext.automationInputSettlingRef.current = true;
          syncAutomationState();
          // SSH/local shell integration emits a private completion marker after
          // the one-shot setup. Matching that marker avoids mistaking a prompt's
          // ordinary OSC 7 report for completion while the setup line is still
          // being echoed on a laggy Windows PTY.
          const suppressor = commandForShell.includes("TaomniCwdIntegrationDone")
            ? createOscMarkerBlankingSuppressor(
                CWD_INTEGRATION_DONE_MARKER,
                integrationTimeoutMs,
                Date.now(),
                inputHoldTimeoutMs,
              )
            : createOsc7BlankingSuppressor(
                integrationTimeoutMs,
                Date.now(),
                inputHoldTimeoutMs,
              );
          controllerContext.injectedInputEchoSuppressorRef.current = suppressor;
          window.setTimeout(() => {
            if (
              destroyed ||
              controllerContext.sessionIdRef.current !== targetSid ||
              controllerContext.injectedInputEchoSuppressorRef.current !== suppressor
            ) return;
            controllerContext.injectedInputEchoSuppressorRef.current = null;
            controllerContext.automationInputSettlingRef.current = false;
            syncAutomationState();
          }, integrationTimeoutMs);
          writeTerminal(targetSid, encodeBase64(`${commandForShell}\r`)).catch(() => {
            if (controllerContext.sessionIdRef.current === targetSid && controllerContext.injectedInputEchoSuppressorRef.current === suppressor) {
              integrationInstalling = false;
              controllerContext.installSshCwdIntegrationRef.current = installCwdIntegration;
              controllerContext.injectedInputEchoSuppressorRef.current = null;
              controllerContext.automationInputSettlingRef.current = false;
              syncAutomationState();
            }
          });
          return true;
        };
        controllerContext.installSshCwdIntegrationRef.current = installCwdIntegration;
        const pollForCwdIntegration = () => {
          if (installCwdIntegration()) return;
          if (destroyed || controllerContext.sessionIdRef.current !== targetSid) return;
          if (integrationAttempts < MAX_INTEGRATION_ATTEMPTS) {
            integrationAttempts += 1;
            window.setTimeout(pollForCwdIntegration, 500);
          } else if (pendingStartupCommand && !startupCommandSent) {
            // Keep the event-driven probe alive until a slow login exposes its prompt.
          } else if (controllerContext.installSshCwdIntegrationRef.current === installCwdIntegration) {
            // A shell that never exposes a prompt (or a non-POSIX prompt that
            // cannot accept the integration command) must not block normal
            // input forever. Stop retrying and expose the stable output we do
            // have; cwd reporting remains unavailable for this session.
            controllerContext.installSshCwdIntegrationRef.current = null;
            controllerContext.automationInputSettlingRef.current = false;
            syncAutomationState();
          }
        };
        window.setTimeout(pollForCwdIntegration, 500);
      };
      if (ssh && !adopted) {
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

      unlistenExit = await listenTerminalExit(connectedSid, () => markDisconnected(connectedSid));

      // Surface per-row local-forward errors (parse, bind, accept,
      // direct-tcpip open) in the same event log the user already sees
      // for connection / auth / disconnect events. Also re-broadcast
      // as a window-level CustomEvent keyed by the persisted session
      // config id so an open SessionEditor can show the failure
      // inline next to the offending forward row.
      unlistenForwardError = await listenTerminalForwardError(connectedSid, (err) => {
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
      if (destroyed) return;
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
      const label = ssh && mode === "reconnect" ? "Reconnect failed" : "Connection failed";
      controllerContext.appendEvent("error", `${label}: ${message}`);
      if (ssh && !adopted) {
        term.write(`\r\n\x1b[31m[${label}] ${message}\x1b[0m\r\n\x1b[33mPress Enter to retry.\x1b[0m\r\n`);
        controllerContext.setStatusMessage(`${label}; press Enter to retry`);
        window.setTimeout(controllerContext.focusTerminal, 0);
      } else {
        term.write(`\x1b[31m${label}: ${message}\x1b[0m\r\n`);
      }
    };

    const startSshConnection = (targetSid: string, mode: ConnectMode) => {
      if (!ssh || adopted || destroyed) return;

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
      const startupCommand = typeof opts.startupCmd === "string" ? opts.startupCmd.trim() : "";
      const keepStartupCommandOpen = startupCommand.length > 0 && opts.doNotExit !== false;
      const backendStartupCommand = startupCommand && !keepStartupCommandOpen ? startupCommand : null;
      // The native output channel can deliver the shell's first prompt before
      // createSshTerminal resolves. Keep those bytes ordered after our notice;
      // writing the notice after the prompt moves xterm's cursor to a blank
      // line and strands prompt detection, cwd setup and task readiness.
      let pendingOutput: Uint8Array[] | null = [];
      const receiveOutput = (raw: Uint8Array) => {
        if (destroyed) return;
        if (pendingOutput) pendingOutput.push(raw.slice());
        else handleRawOutput(raw);
      };
      const releaseOutput = () => {
        const buffered = pendingOutput;
        pendingOutput = null;
        if (!destroyed) buffered?.forEach(handleRawOutput);
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
          if (!destroyed) {
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
      if (!controllerContext.commandTerminal || adopted || destroyed) return;

      clearConnectionListeners();
      controllerContext.connectionStateRef.current = "connecting";
      if (controllerContext.tabId) controllerContext.setTerminalRuntime(controllerContext.tabId, { state: "connecting", program: undefined });
      controllerContext.sessionIdRef.current = null;
      controllerContext.setRegisteredSessionId(null);
      controllerContext.zmodemRef.current = null;

      const endpoint = controllerContext.commandTerminal.kind === "Serial"
        ? controllerContext.commandTerminal.host
        : `${controllerContext.commandTerminal.username ? `${controllerContext.commandTerminal.username}@` : ""}${controllerContext.commandTerminal.host}${
            controllerContext.commandTerminal.port > 0 ? `:${controllerContext.commandTerminal.port}` : ""
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
      if (!ssh || adopted || destroyed) return;
      if (controllerContext.connectionStateRef.current !== "disconnected") return;
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
      sshLaunchTimer = window.setTimeout(() => startSshConnection(sid, "initial"), 0);
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
      sockscapLaunchTimer = window.setTimeout(() => {
        if (destroyed) return;
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
            if (destroyed) {
              void closeTerminal(sid).catch(() => {});
              void sockscapStopLaunchedApp(launched.pid).catch(() => {});
              return;
            }
            launchedSockscapPid = launched.pid;
            return handleConnected({ sessionId: sid, shellId: null }, "initial");
          })
          .catch((err) => {
            if (!destroyed) handleConnectFailure(err, "initial");
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

    return () => {
      destroyed = true;
      observer.disconnect();
      el.removeEventListener("scroll", onContainerScroll);
      selectionDisposable.dispose();
      scrollDisposable.dispose();
      renderDisposable.dispose();
      resizeDisposable.dispose();
      clearTimeout(resizeTimer);
      window.clearInterval(automationStateTimer);
      if (activityPromptTimer) clearTimeout(activityPromptTimer);
      if (sshLaunchTimer !== undefined) clearTimeout(sshLaunchTimer);
      if (sockscapLaunchTimer) clearTimeout(sockscapLaunchTimer);
      controllerContext.installSshCwdIntegrationRef.current = null;
      controllerContext.automationInputSettlingRef.current = false;
      // Drop (never deliver) keystrokes still held for a hidden setup line.
      const heldInput = controllerContext.injectedInputHoldRef.current;
      if (heldInput.pump !== null) {
        window.clearInterval(heldInput.pump);
        heldInput.pump = null;
      }
      heldInput.queue = [];
      unlistenExit?.();
      unlistenForwardError?.();
      unlistenAuthPrompt?.();
      // Cancel any MFA prompt still awaiting an answer so the backend's auth
      // task stops blocking and tears the half-open connection down.
      if (controllerContext.pendingMfaRequestIdRef.current) {
        void submitSshAuthResponse(controllerContext.pendingMfaRequestIdRef.current, null).catch(() => {});
        controllerContext.pendingMfaRequestIdRef.current = null;
      }
      detachImeGuard?.();
      cleanupImePositionLock?.();
      if (controllerContext.loggingActiveRef.current && controllerContext.outputLogRef.current) {
        controllerContext.flushRecordedOutput("Terminal closed; saved recorded output");
      }
      if (controllerContext.sessionIdRef.current && !controllerContext.preserveSessionOnUnmountRef.current) {
        const detachPending = controllerContext.tabId ? consumeTerminalDetachPending(controllerContext.tabId) : false;
        // Adopted sessions are owned by whoever originally created them —
        // don't close on unmount, even when StrictMode double-mounts.
        if (!detachPending && !adopted) {
          closeTerminal(controllerContext.sessionIdRef.current).catch(() => {});
        }
      }
      if (launchedSockscapPid !== null) {
        void sockscapStopLaunchedApp(launchedSockscapPid).catch(() => {});
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
  };
}
