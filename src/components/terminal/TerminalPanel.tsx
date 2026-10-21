import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Terminal } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import { SearchAddon } from "@xterm/addon-search";
import { loadTerminalDefaultProfile, resolveTerminalThemeWithSystem, saveTerminalDefaultProfile, type TerminalProfile, type TerminalSyntaxMode, type UserCommonCommand } from "../../lib/terminalProfile";
import { TerminalImeInputGuard } from "../../lib/terminalImeGuard";
import { isEditableTarget, isTerminalFocused } from "../../lib/terminal/keyboardGuards";
import { readFiles as clipboardReadFiles } from "../../lib/clipboard";
import { useAppTheme } from "../../lib/appTheme";
import { ScreenshotMenuButton } from "../screenshot/ScreenshotMenuButton";
import { TabActions } from "../tabbar/TabActionSlot";
import { useConfirmDialog } from "../sidebar/ConfirmDialog";
import { FT_BUTTON_STYLE, FT_BUTTON_ACTIVE_OVERRIDE, FT_ICON_BUTTON_STYLE } from "../floating-toolbar/floatingToolbarStyles";
import { Bot, ExternalLink, FolderOpen, Maximize2, Minimize2 } from "lucide-react";
import { createTaskStartOutputSuppressor, type InputEchoSuppressor } from "../../lib/terminalOutputFilter";
import { makeHostKey, useCommandHistory } from "../../lib/history";
import { submitSshAuthResponse, type SshAuthPromptPayload, writeTerminal, resizeTerminal, sendTerminalSignal, ccTrackTerminal, ccUntrackTerminal, encodeBase64, selectUploadFile } from "../../lib/ipc";
import { getAppPlatform } from "../../lib/runtime";
import { inferTerminalProgram } from "../../lib/terminalActivity";
import { buildInteractiveCommandInput, renderTerminalTask, type TerminalTaskVariables } from "../../lib/terminal/commandInput";
import { registerTerminal } from "../../lib/terminal/terminalRegistry";
import { ZmodemSession, type ZmodemState, type ZmodemProgress, type ZmodemSendFile, type ConflictAction, type SendConflictAction } from "../../lib/zmodem";
import { ZmodemConflictDialog } from "./ZmodemConflictDialog";
import { MfaPrompt } from "../session/MfaPrompt";
import { CommonCommandsPalette } from "./CommonCommandsPalette";
import { AiRewriteOverlay } from "./AiRewriteOverlay";
import { SelectionToolbar } from "./SelectionToolbar";
import { useChatStore } from "../../stores/chatStore";
import { WINDOWS_PRESET_COMMANDS } from "../../lib/commonCommandsPresets";
import { useAppStore } from "../../stores/appStore";
import { useContextMenu } from "../ContextMenu";
import { promptAppDialog } from "../../lib/appDialogs";
import { useT } from "../../lib/i18n";
import { gitProbePath, gitSnapshot } from "../../lib/git";
import "@xterm/xterm/css/xterm.css";
import { type TerminalPanelProps, type TerminalConnectionState, type TerminalBlockSelection, type TerminalEventLogEntry, type TerminalReattachState, type TerminalGitState, type TerminalBlockSelectionCell } from "./panel/types";
import { terminalProfileSignature } from "./panel/transfer";
import { currentTerminalSize, shouldUseTerminalWebgl, DEFAULT_FONT_SIZE, terminalCursorCell } from "./panel/policy";
import { getBufferText, collectTerminalBlockSelectionText, getLastBufferLines, terminalAtIdlePrompt, getVisibleSearchHighlights, getVisibleKeywordHighlights, getVisibleTerminalBlockSelectionHighlights, computeInlineGhost } from "./panel/buffer";
import { CWD_QUERY_COMMAND, PS_CWD_QUERY_COMMAND, formatZmodemBytes } from "./panel/protocol";
import { CurrentTerminalSettingsDialog } from "./panel/CurrentTerminalSettingsDialog";
import { createTerminalSessionLifecycle } from "./panel/sessionLifecycle";
import { useTerminalViewport } from "./panel/useTerminalViewport";
import { useTerminalSuggestions } from "./panel/useTerminalSuggestions";
import { useTerminalInput } from "./panel/useTerminalInput";
import { useTerminalClipboard } from "./panel/useTerminalClipboard";
import { useTerminalRecording } from "./panel/useTerminalRecording";
import { useTerminalSearchActions } from "./panel/useTerminalSearchActions";
import { useTerminalShortcuts } from "./panel/useTerminalShortcuts";
import { useTerminalContextMenu } from "./panel/useTerminalContextMenu";
import { useTerminalPointer } from "./panel/useTerminalPointer";











 // ESC [ 3 J

export function TerminalPanel({
  tabId,
  tabTitle = "Terminal",
  theme = "classic",
  ssh,
  commandTerminal,
  localShell,
  terminalProfile,
  onTerminalProfileChange,
  adoptedTerminal,
  sockscapTerminal,
  initialCwd,
  workspaceRoot,
  preserveSessionOnUnmount = false,
  detachedWindowControls,
  onDetachedStateChange,
  visible = true,
  activeForShortcuts = visible,
  inputLocked = false,
  onCwdChange,
  cwdRequestToken = 0,
  onSessionReady,
  onSessionLaunchFailed,
  onOutput,
  onTaskExit,
  onUploadLocalPaths,
  multiExecActive,
  isMultiExecTarget,
  onInputBroadcast,
  sftpToggle,
  chatToggle,
  gitToggle,
  detachToggle,
}: TerminalPanelProps) {
  const t = useT();
  const { confirm: confirmPaste, render: pasteConfirmDialog } = useConfirmDialog();
  const { confirm: confirmTerminalDefaults, render: terminalDefaultsConfirmDialog } = useConfirmDialog();
  const cwdCallbackRef = useRef<typeof onCwdChange>(onCwdChange);
  const onSessionReadyRef = useRef<typeof onSessionReady>(onSessionReady);
  const onSessionLaunchFailedRef = useRef<typeof onSessionLaunchFailed>(onSessionLaunchFailed);
  const onOutputRef = useRef<typeof onOutput>(onOutput);
  const onTaskExitRef = useRef<typeof onTaskExit>(onTaskExit);
  const onUploadLocalPathsRef = useRef<typeof onUploadLocalPaths>(onUploadLocalPaths);
  const onInputBroadcastRef = useRef<typeof onInputBroadcast>(onInputBroadcast);
  const onTerminalProfileChangeRef = useRef<typeof onTerminalProfileChange>(onTerminalProfileChange);
  const onDetachedStateChangeRef = useRef<typeof onDetachedStateChange>(onDetachedStateChange);
  const preserveSessionOnUnmountRef = useRef(preserveSessionOnUnmount);
  const adoptedTerminalRef = useRef(adoptedTerminal);
  const workspaceRootRef = useRef(workspaceRoot);
  const multiExecActiveRef = useRef(multiExecActive);
  useEffect(() => {
    cwdCallbackRef.current = onCwdChange;
    onSessionReadyRef.current = onSessionReady;
    onSessionLaunchFailedRef.current = onSessionLaunchFailed;
    onOutputRef.current = onOutput;
    onTaskExitRef.current = onTaskExit;
    onUploadLocalPathsRef.current = onUploadLocalPaths;
    onInputBroadcastRef.current = onInputBroadcast;
    onTerminalProfileChangeRef.current = onTerminalProfileChange;
    onDetachedStateChangeRef.current = onDetachedStateChange;
    preserveSessionOnUnmountRef.current = preserveSessionOnUnmount;
    workspaceRootRef.current = workspaceRoot;
    multiExecActiveRef.current = multiExecActive;
  }, [
    onCwdChange,
    onSessionReady,
    onOutput,
    onTaskExit,
    onUploadLocalPaths,
    onInputBroadcast,
    onTerminalProfileChange,
    onDetachedStateChange,
    preserveSessionOnUnmount,
    workspaceRoot,
    multiExecActive,
  ]);
  const containerRef = useRef<HTMLDivElement>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const searchAddonRef = useRef<SearchAddon | null>(null);
  const sessionIdRef = useRef<string | null>(null);
  const sdkTaskEnvironmentRef = useRef<Record<string, string>>({});
  const connectionStateRef = useRef<TerminalConnectionState>("idle");
  const reconnectSshRef = useRef<(() => void) | null>(null);
  // Mirrors `sessionIdRef.current` as state so the registry-effect below
  // re-runs whenever the backend session id changes.
  const [registeredSessionId, setRegisteredSessionId] = useState<string | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const latestCwdRef = useRef<string | null>(initialCwd ?? null);
  const panelRef = useRef<HTMLDivElement>(null);
  const initializedRef = useRef(false);
  const readOnlyRef = useRef(false);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const contextMenu = useContextMenu();
  const setStatusMessage = useAppStore((s) => s.setStatusMessage);
  const updateTabTitle = useAppStore((s) => s.updateTabTitle);
  const setTerminalRuntime = useAppStore((s) => s.setTerminalRuntime);
  const attachToComposer = useChatStore((s) => s.attachToComposer);
  const explainSelection = useChatStore((s) => s.explainSelection);
  const isLocal = !ssh && !commandTerminal;
  const supportsShellTools = !sockscapTerminal;
  const initialProfileRef = useRef<TerminalProfile | null>(null);
  if (!initialProfileRef.current) {
    initialProfileRef.current = terminalProfile ?? loadTerminalDefaultProfile();
  }
  const initialProfile = initialProfileRef.current;
  const appliedTerminalProfileSignatureRef = useRef<string | null>(
    terminalProfile ? terminalProfileSignature(terminalProfile) : null,
  );

  useEffect(() => {
    if (!tabId) return;
    setTerminalRuntime(tabId, { state: "connecting", program: undefined });
  }, [setTerminalRuntime, tabId]);
  const currentTerminalProfileRef = useRef<TerminalProfile>(initialProfile);

  const [fontFamily, setFontFamily] = useState(initialProfile.fontFamily);
  const [fontSize, setFontSize] = useState(initialProfile.fontSize);
  const [fontLigatures, setFontLigatures] = useState(initialProfile.fontLigatures);
  const [showScrollbar, setShowScrollbar] = useState(initialProfile.showScrollbar);
  const [webglRenderer, setWebglRenderer] = useState(initialProfile.webglRenderer);
  const [readOnly, setReadOnly] = useState(initialProfile.readOnly);
  const [themeName, setThemeName] = useState(initialProfile.theme || theme);
  const { resolvedTheme: resolvedAppTheme } = useAppTheme();
  const appPrefersDark = resolvedAppTheme === "dark";
  const resolvePanelTheme = useCallback(
    (name: string) => resolveTerminalThemeWithSystem(name, appPrefersDark),
    [appPrefersDark],
  );
  const [cursorStyle, setCursorStyle] = useState(initialProfile.cursorStyle);
  const [cursorBlink, setCursorBlink] = useState(initialProfile.cursorBlink);
  const [scrollback, setScrollback] = useState(initialProfile.scrollback);
  const [syntaxMode, setSyntaxMode] = useState<TerminalSyntaxMode>(initialProfile.syntaxMode);
  const [rightClickBehavior, setRightClickBehavior] = useState(initialProfile.rightClickBehavior);
  const [copyOnSelect, setCopyOnSelect] = useState(initialProfile.copyOnSelect);
  const [allowRemoteOsc52Clipboard, setAllowRemoteOsc52Clipboard] = useState(initialProfile.allowRemoteOsc52Clipboard);
  const [loggingActive, setLoggingActive] = useState(initialProfile.loggingEnabled);
  const [multilinePasteConfirm, setMultilinePasteConfirm] = useState(initialProfile.multilinePasteConfirm);
  const [inlineSuggestionsEnabled, setInlineSuggestionsEnabled] = useState(initialProfile.inlineSuggestions);
  const [inlineSuggestionsMax, setInlineSuggestionsMax] = useState(initialProfile.inlineSuggestionsMax);
  const [inlineSuggestionsSource, setInlineSuggestionsSource] = useState(initialProfile.inlineSuggestionsSource);
  const [aiCommandRewriteEnabled, setAiCommandRewriteEnabled] = useState(initialProfile.aiCommandRewriteEnabled);
  const [aiRewriteOpen, setAiRewriteOpen] = useState(false);
  const [selectionToolbar, setSelectionToolbar] = useState<{
    rect: { top: number; left: number; right: number; bottom: number };
    text: string;
  } | null>(null);
  const [blockSelection, setBlockSelection] = useState<TerminalBlockSelection | null>(null);
  const [commonCommands, setCommonCommands] = useState<UserCommonCommand[]>(initialProfile.commonCommands);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [settingsDialogOpen, setSettingsDialogOpen] = useState(false);

  const commitTerminalProfilePatch = useCallback((patch: Partial<TerminalProfile>) => {
    const next: TerminalProfile = { ...currentTerminalProfileRef.current, ...patch };
    currentTerminalProfileRef.current = next;

    if (patch.fontFamily !== undefined) setFontFamily(next.fontFamily);
    if (patch.fontSize !== undefined) setFontSize(next.fontSize);
    if (patch.fontLigatures !== undefined) setFontLigatures(next.fontLigatures);
    if (patch.showScrollbar !== undefined) setShowScrollbar(next.showScrollbar);
    if (patch.webglRenderer !== undefined) setWebglRenderer(next.webglRenderer);
    if (patch.readOnly !== undefined) setReadOnly(next.readOnly);
    if (patch.theme !== undefined) setThemeName(next.theme || theme);
    if (patch.cursorStyle !== undefined) setCursorStyle(next.cursorStyle);
    if (patch.cursorBlink !== undefined) setCursorBlink(next.cursorBlink);
    if (patch.scrollback !== undefined) setScrollback(next.scrollback);
    if (patch.syntaxMode !== undefined) setSyntaxMode(next.syntaxMode);
    if (patch.rightClickBehavior !== undefined) setRightClickBehavior(next.rightClickBehavior);
    if (patch.copyOnSelect !== undefined) setCopyOnSelect(next.copyOnSelect);
    if (patch.allowRemoteOsc52Clipboard !== undefined) {
      setAllowRemoteOsc52Clipboard(next.allowRemoteOsc52Clipboard);
    }
    if (patch.loggingEnabled !== undefined) setLoggingActive(next.loggingEnabled);
    if (patch.multilinePasteConfirm !== undefined) {
      setMultilinePasteConfirm(next.multilinePasteConfirm);
    }
    if (patch.inlineSuggestions !== undefined) setInlineSuggestionsEnabled(next.inlineSuggestions);
    if (patch.inlineSuggestionsMax !== undefined) setInlineSuggestionsMax(next.inlineSuggestionsMax);
    if (patch.inlineSuggestionsSource !== undefined) {
      setInlineSuggestionsSource(next.inlineSuggestionsSource);
    }
    if (patch.aiCommandRewriteEnabled !== undefined) {
      setAiCommandRewriteEnabled(next.aiCommandRewriteEnabled);
    }
    if (patch.commonCommands !== undefined) setCommonCommands(next.commonCommands);

    onTerminalProfileChangeRef.current?.(next);
  }, [theme]);

  const [fullscreen, setFullscreen] = useState(false);

  useEffect(() => {
    currentTerminalProfileRef.current = {
      ...currentTerminalProfileRef.current,
      fontFamily,
      fontSize,
      fontLigatures,
      theme: themeName,
      scrollback,
      cursorStyle,
      cursorBlink,
      showScrollbar,
      webglRenderer,
      readOnly,
      syntaxMode,
      rightClickBehavior,
      copyOnSelect,
      allowRemoteOsc52Clipboard,
      loggingEnabled: loggingActive,
      multilinePasteConfirm,
      inlineSuggestions: inlineSuggestionsEnabled,
      inlineSuggestionsMax,
      inlineSuggestionsSource,
      aiCommandRewriteEnabled,
      commonCommands,
    };
  }, [
    aiCommandRewriteEnabled,
    allowRemoteOsc52Clipboard,
    commonCommands,
    copyOnSelect,
    cursorBlink,
    cursorStyle,
    fontFamily,
    fontLigatures,
    fontSize,
    inlineSuggestionsEnabled,
    inlineSuggestionsMax,
    inlineSuggestionsSource,
    loggingActive,
    multilinePasteConfirm,
    readOnly,
    rightClickBehavior,
    scrollback,
    showScrollbar,
    syntaxMode,
    themeName,
    webglRenderer,
  ]);
  const [eventLogOpen, setEventLogOpen] = useState(false);
  const [viewportVersion, setViewportVersion] = useState(0);
  const [eventLog, setEventLog] = useState<TerminalEventLogEntry[]>([]);
  const [macroRecording, setMacroRecording] = useState(false);
  const [zmodemState, setZmodemState] = useState<ZmodemState>("idle");
  const [zmodemProgress, setZmodemProgress] = useState<ZmodemProgress | null>(null);
  const zmodemRef = useRef<ZmodemSession | null>(null);
  const zmodemSaveDirRef = useRef<string | undefined>(undefined);
  const [conflictDialogState, setConflictDialogState] = useState<{
    fileName: string;
    hasMore: boolean;
    mode: "receive" | "send";
    resolve: (action: ConflictAction | SendConflictAction) => void;
  } | null>(null);
  // Pending keyboard-interactive (MFA/OTP) auth prompt surfaced mid-connect.
  // `null` when no prompt is active.
  const [mfaPrompt, setMfaPrompt] = useState<SshAuthPromptPayload | null>(null);
  // Holds the request id of the prompt awaiting an answer so unmount cleanup
  // can cancel an unanswered round (telling the backend to abort connect).
  const pendingMfaRequestIdRef = useRef<string | null>(null);
  const outputLogRef = useRef("");
  const loggingActiveRef = useRef(loggingActive);
  const copyOnSelectRef = useRef(copyOnSelect);
  const webglRendererRef = useRef(webglRenderer);
  const allowRemoteOsc52ClipboardRef = useRef(allowRemoteOsc52Clipboard);
  const macroRecordingRef = useRef(macroRecording);
  const macroBufferRef = useRef("");
  const lastMacroRef = useRef("");
  const macroPlaybackRef = useRef(false);
  const eventIdRef = useRef(0);
  const imeGuardRef = useRef<TerminalImeInputGuard | null>(null);
  const isComposingRef = useRef(false);
  const compositionBufferRef = useRef<Uint8Array[]>([]);
  const injectedInputEchoSuppressorRef = useRef<InputEchoSuppressor | null>(null);
  // SSH login scripts and startup commands can take longer than the initial
  // polling window. Keep a deferred installer so the first later idle prompt
  // can still enable continuous OSC 7 cwd reporting.
  const installSshCwdIntegrationRef = useRef<(() => boolean) | null>(null);
  const automationInputSettlingRef = useRef(false);
  const webglAddonRef = useRef<{
    addon: WebglAddon;
    contextLossDisposable: { dispose: () => void } | null;
  } | null>(null);
  const suppressNativePasteUntilRef = useRef(0);
  const middleClickSelectionRef = useRef("");
  const blockSelectionRef = useRef<TerminalBlockSelection | null>(null);
  const blockSelectionTextRef = useRef("");
  const lastMacMiddlePasteAtRef = useRef(0);
  const lastTerminalSizeSyncRef = useRef<{ sessionId: string; cols: number; rows: number } | null>(null);
  const lastCwdRequestTokenRef = useRef(cwdRequestToken);

  const syncTerminalSize = useCallback((force = false) => {
    const sid = sessionIdRef.current;
    const term = termRef.current;
    if (!sid || !term) return;

    const { cols, rows } = currentTerminalSize(term);
    const previous = lastTerminalSizeSyncRef.current;
    if (!force && previous?.sessionId === sid && previous.cols === cols && previous.rows === rows) {
      return;
    }
    lastTerminalSizeSyncRef.current = { sessionId: sid, cols, rows };
    resizeTerminal(sid, cols, rows).catch(() => {
      if (lastTerminalSizeSyncRef.current?.sessionId === sid) {
        lastTerminalSizeSyncRef.current = null;
      }
    });
  }, []);

  const fitVisibleTerminal = useCallback((forceSync = false) => {
    const el = containerRef.current;
    const term = termRef.current;
    const fitAddon = fitAddonRef.current;
    if (!el || !term || !fitAddon || el.clientWidth === 0 || el.clientHeight === 0) {
      return;
    }

    try {
      fitAddon.fit();
      term.refresh(0, term.rows - 1);
      syncTerminalSize(forceSync);
    } catch {
      // Hidden tabs can briefly report invalid dimensions while switching.
    }
  }, [syncTerminalSize]);

  const scheduleTerminalFitAndSync = useCallback((forceSync = false) => {
    const run = () => {
      if (!termRef.current) return;
      window.requestAnimationFrame(() => {
        if (termRef.current) fitVisibleTerminal(forceSync);
      });
    };
    run();
    window.setTimeout(run, 80);
    window.setTimeout(run, 300);
  }, [fitVisibleTerminal]);

  const focusTerminal = useCallback(() => {
    termRef.current?.focus();
  }, []);

  const disposeTerminalWebgl = useCallback((term: Terminal | null) => {
    const record = webglAddonRef.current;
    if (!record) return;

    webglAddonRef.current = null;
    record.contextLossDisposable?.dispose();
    try {
      record.addon.dispose();
    } catch {
      /* WebGL addon disposal is best-effort during renderer fallback. */
    }
    if (term) {
      term.refresh(0, Math.max(0, term.rows - 1));
    }
  }, []);

  const installTerminalWebgl = useCallback((term: Terminal) => {
    if (!shouldUseTerminalWebgl(webglRendererRef.current) || webglAddonRef.current) return;

    let addon: WebglAddon | null = null;
    let contextLossDisposable: { dispose: () => void } | null = null;
    try {
      addon = new WebglAddon();
      const currentAddon = addon;
      contextLossDisposable = currentAddon.onContextLoss(() => {
        if (webglAddonRef.current?.addon !== currentAddon) return;
        disposeTerminalWebgl(term);
        setStatusMessage("Terminal WebGL renderer lost; using stable renderer");
      });
      term.loadAddon(currentAddon);
      webglAddonRef.current = { addon: currentAddon, contextLossDisposable };
    } catch {
      contextLossDisposable?.dispose();
      try {
        addon?.dispose();
      } catch {
        /* WebGL not available. */
      }
    }
  }, [disposeTerminalWebgl, setStatusMessage]);

  const collectReattachState = useCallback((): TerminalReattachState => {
    const term = termRef.current;
    return {
      terminalSessionId: sessionIdRef.current ?? undefined,
      snapshotText: term ? getBufferText(term) : undefined,
    };
  }, []);

  const appendEvent = useCallback((type: string, detail: string) => {
    const entry: TerminalEventLogEntry = {
      id: ++eventIdRef.current,
      time: new Date().toLocaleTimeString(),
      type,
      detail,
    };
    setEventLog((items) => [...items.slice(-199), entry]);
  }, []);


  // Per-host command history for inline ghost-text suggestions.
  const historyHostKey = useMemo(
    () => commandTerminal
      ? `client:${commandTerminal.kind}:${commandTerminal.host.toLowerCase()}:${commandTerminal.port}:${commandTerminal.username ?? ""}`
      : makeHostKey(ssh),
    [commandTerminal, ssh],
  );
  // Tracks which local shell the backend actually launched. Lets us suppress
  // inline history suggestions on shells that already provide their own
  // (PSReadLine on PowerShell). Resolved on connect — the prop only carries
  // the user's selection, which can be missing when opening a saved
  // LocalShell session, so we trust the backend's resolved id instead.
  const [resolvedLocalShellId, setResolvedLocalShellId] = useState<string | null>(null);
  const isLocalPowerShell = useMemo(
    () =>
      isLocal &&
      (resolvedLocalShellId
        ? (resolvedLocalShellId === "powershell" || resolvedLocalShellId === "windows-powershell")
        : (localShell?.id === "powershell" || localShell?.id === "windows-powershell")),
    [isLocal, resolvedLocalShellId, localShell?.id],
  );
  const suggestionsActive =
    supportsShellTools && inlineSuggestionsEnabled && !isLocalPowerShell;
  const history = useCommandHistory(historyHostKey, inlineSuggestionsMax);

  // Which command (if any) can probe this terminal's cwd via OSC 7. SSH and
  // POSIX local shells use the `printf` form; PowerShell uses a [Console]::Write
  // form; cmd.exe can't emit OSC 7 cleanly, so it has no probe. Resolved
  // reactively because the backend reports the real local shell on connect.
  const isLocalCmd = useMemo(
    () =>
      isLocal &&
      (resolvedLocalShellId === "command-prompt" ||
        /cmd\.exe|command[\s-]?prompt/i.test(`${localShell?.id ?? ""} ${localShell?.name ?? ""}`)),
    [isLocal, resolvedLocalShellId, localShell?.id, localShell?.name],
  );
  const cwdProbeCommand = useMemo<string | null>(() => {
    if (commandTerminal || sockscapTerminal) return null;
    if (!isLocal) return CWD_QUERY_COMMAND; // SSH → remote POSIX shell.
    if (isLocalCmd) return null;
    if (isLocalPowerShell) return PS_CWD_QUERY_COMMAND;
    return CWD_QUERY_COMMAND; // bash/zsh/git-bash/WSL/Unix default.
  }, [isLocal, isLocalCmd, isLocalPowerShell, sockscapTerminal]);
  const cwdProbeCommandRef = useRef(cwdProbeCommand);
  useEffect(() => {
    cwdProbeCommandRef.current = cwdProbeCommand;
  }, [cwdProbeCommand]);

  const [gitState, setGitState] = useState<TerminalGitState>({
    kind: "unknown",
    label: "Git",
    title: "Open Git panel",
  });

  useEffect(() => {
    if (!isLocal || !gitToggle) {
      setGitState({ kind: "unknown", label: "Git", title: "Open Git panel" });
      return;
    }
    const cwd = gitToggle.cwd?.trim();
    if (!cwd) {
      setGitState({ kind: "unknown", label: "Git", title: "Waiting for terminal cwd" });
      return;
    }
    let cancelled = false;
    const timer = window.setTimeout(() => {
      gitProbePath(cwd)
        .then(async (probe) => {
          if (cancelled) return;
          if (!probe.gitAvailable) {
            setGitState({ kind: "error", label: "Git", title: probe.error ?? "Git executable was not found" });
            return;
          }
          if (!probe.isRepo || !probe.repoRoot) {
            setGitState({ kind: "none", label: "Git", title: "Initialize Git repository" });
            return;
          }
          try {
            const snapshot = await gitSnapshot(probe.repoRoot);
            if (cancelled) return;
            setGitState({
              kind: "repo",
              label: snapshot.currentBranch ?? snapshot.headOid ?? "repo",
              title: `Open Git panel for ${probe.repoRoot}`,
              repoRoot: probe.repoRoot,
            });
          } catch {
            if (!cancelled) {
              setGitState({ kind: "repo", label: "repo", title: `Open Git panel for ${probe.repoRoot}`, repoRoot: probe.repoRoot });
            }
          }
        })
        .catch((err) => {
          if (!cancelled) {
            setGitState({
              kind: "error",
              label: "Git",
              title: err instanceof Error ? err.message : String(err),
            });
          }
        });
    }, 350);
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [gitToggle?.cwd, isLocal]);
  const { trackPending, pendingRef, invalidatedRef, refreshSuggestion, suggestionsActiveRef, suggestionRef, ghostVisibleRef, bumpGhost, pendingLocalDirectoryReportsRef, isLocalRef, lastRecordedLocalDirRef, historyRef, ghostTick } = useTerminalSuggestions({
    history,
    suggestionsActive,
    inlineSuggestionsSource,
    isLocal,
    termRef,
  });
  const { writeBroadcastInput, writeInput, sendTerminalInput, requestTerminalCwd, writeXtermInput, writeBinaryInput, injectedInputHoldRef } = useTerminalInput({
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
  });
  const { clearTerminalBlockSelection, updateTerminalBlockSelection, showTerminalSelectionToolbar, getActiveTerminalSelectionText, copySelection, pasteFromClipboard, copyAll, copyFormattedSelection, writeClipboardText, handleLocalFilePaths, pasteTextIntoTerminal, handleTerminalDragOver, handleTerminalDrop } = useTerminalClipboard({
    setStatusMessage,
    setSelectionToolbar,
    containerRef,
    blockSelectionRef,
    termRef,
    blockSelectionTextRef,
    setBlockSelection,
    focusTerminal,
    resolvePanelTheme,
    themeName,
    fontFamily,
    fontSize,
    readOnlyRef,
    multilinePasteConfirm,
    confirmPaste,
    t,
    writeBroadcastInput,
    isLocal,
    resolvedLocalShellId,
    localShell,
    appendEvent,
    onUploadLocalPathsRef,
    latestCwdRef,
    panelRef,
  });
  const { saveBufferToFile, executeMacro, toggleMacroRecording, toggleOutputRecording, flushRecordedOutput } = useTerminalRecording({
    termRef,
    tabTitle,
    appendEvent,
    setStatusMessage,
    focusTerminal,
    outputLogRef,
    setLoggingActive,
    setMacroRecording,
    lastMacroRef,
    macroBufferRef,
    macroPlaybackRef,
    writeInput,
  });
  const { openSearch, closeSearch, cancelPendingSearch, runSearch, setSearchStatus, setSearchMatches, setActiveSearchIndex, searchValue, fallbackSearchRef, searchOpen, searchMatches, activeSearchIndex, setSearchValue, searchStatus } = useTerminalSearchActions({ searchAddonRef, termRef, clearTerminalBlockSelection, focusTerminal, searchInputRef });

  const renameTerminal = useCallback(async () => {
    if (!tabId) return;
    const nextTitle = await promptAppDialog({
      title: "Set terminal title",
      initialValue: tabTitle,
      allowEmpty: true,
    });
    if (!nextTitle?.trim()) return;
    updateTabTitle(tabId, nextTitle.trim());
    focusTerminal();
  }, [focusTerminal, tabId, tabTitle, updateTabTitle]);

  const resetOutput = useCallback(() => {
    termRef.current?.reset();
    fitVisibleTerminal();
    focusTerminal();
  }, [fitVisibleTerminal, focusTerminal]);

  const clearScrollback = useCallback(() => {
    termRef.current?.clear();
    focusTerminal();
  }, [focusTerminal]);

  const increaseFontSize = useCallback(() => {
    const nextSize = Math.min(currentTerminalProfileRef.current.fontSize + 1, 32);
    commitTerminalProfilePatch({ fontSize: nextSize });
  }, [commitTerminalProfilePatch]);

  const decreaseFontSize = useCallback(() => {
    const nextSize = Math.max(currentTerminalProfileRef.current.fontSize - 1, 8);
    commitTerminalProfilePatch({ fontSize: nextSize });
  }, [commitTerminalProfilePatch]);

  const resetFontSize = useCallback(() => {
    commitTerminalProfilePatch({ fontSize: DEFAULT_FONT_SIZE });
  }, [commitTerminalProfilePatch]);

  const setSyntaxModeAndFocus = useCallback((mode: TerminalSyntaxMode) => {
    commitTerminalProfilePatch({ syntaxMode: mode });
    focusTerminal();
  }, [commitTerminalProfilePatch, focusTerminal]);

  const saveCurrentAppearanceAsTerminalDefault = useCallback(() => {
    const currentDefault = loadTerminalDefaultProfile();
    const currentProfile = currentTerminalProfileRef.current;
    saveTerminalDefaultProfile({
      ...currentDefault,
      theme: currentProfile.theme,
      fontFamily: currentProfile.fontFamily,
      fontSize: currentProfile.fontSize,
      fontLigatures: currentProfile.fontLigatures,
    });
    setStatusMessage(t("terminal.defaultAppearanceSaved"));
  }, [setStatusMessage, t]);

  const saveCurrentProfileAsTerminalDefault = useCallback(async () => {
    const confirmed = await confirmTerminalDefaults({
      title: t("terminal.saveAllDefaultConfirmTitle"),
      message: t("terminal.saveAllDefaultConfirmMessage"),
      confirmLabel: t("terminal.saveAllDefaultConfirmButton"),
    });
    if (!confirmed) return;
    saveTerminalDefaultProfile(currentTerminalProfileRef.current);
    setStatusMessage(t("terminal.defaultProfileSaved"));
  }, [confirmTerminalDefaults, setStatusMessage, t]);

  const selectZmodemSendFiles = useCallback(async (): Promise<ZmodemSendFile[]> => {
    const filePaths = await selectUploadFile();
    if (!filePaths || filePaths.length === 0) return [];

    const files: ZmodemSendFile[] = [];
    for (const filePath of filePaths) {
      const fileName = filePath.replace(/\\/g, "/").split("/").pop() ?? "file";
      files.push({ name: fileName, path: filePath });
    }
    return files;
  }, []);

  const startZmodemSend = useCallback(async () => {
    if (!zmodemRef.current) {
      setStatusMessage("Terminal not ready for ZMODEM");
      return;
    }
    if (zmodemRef.current.isActive) {
      setStatusMessage("A ZMODEM transfer is already in progress");
      return;
    }
    try {
      const files = await selectZmodemSendFiles();
      if (files.length === 0) return;
      zmodemRef.current.queueSend(files);
      sendTerminalInput("rz\r");
      const names = files.map((f) => f.name).join(", ");
      setStatusMessage(`Sending ${files.length === 1 ? files[0].name : `${files.length} files (${names})`} via ZMODEM…`);
    } catch (err) {
      setStatusMessage(err instanceof Error ? err.message : "ZMODEM send failed");
    }
    focusTerminal();
  }, [focusTerminal, selectZmodemSendFiles, sendTerminalInput, setStatusMessage]);

  const sendSpecialSignal = useCallback((signal: string, fallback?: string) => {
    const sid = sessionIdRef.current;
    if (!sid) return;
    // PTY-backed SSH sessions receive terminal control bytes more reliably
    // than SSH channel requests on Windows OpenSSH/ConPTY. Some servers
    // acknowledge channel.signal(SIGINT) by closing the channel, which leaves
    // the interactive session unusable even though Ctrl-C is supported.
    if (ssh && fallback) {
      writeInput(fallback);
      appendEvent("signal", `Sent ${signal} control character`);
      setStatusMessage(`Sent ${signal}`);
      focusTerminal();
      return;
    }
    sendTerminalSignal(sid, signal)
      .then(() => {
        appendEvent("signal", `Sent ${signal}`);
        setStatusMessage(`Sent ${signal}`);
      })
      .catch((err) => {
        if (fallback) {
          writeInput(fallback);
          appendEvent("signal", `Sent ${signal} fallback control character`);
          setStatusMessage(`Sent ${signal} fallback`);
        } else {
          appendEvent("error", `${signal} failed: ${String(err)}`);
          setStatusMessage(err instanceof Error ? err.message : String(err));
        }
      });
    focusTerminal();
  }, [appendEvent, focusTerminal, setStatusMessage, writeInput]);

  // Sends raw input to the terminal (and broadcasts when MultiExec is active)
  // WITHOUT running the pending-command tracker. Used by inline-suggestion
  // accept, which manages pending state explicitly.
  const sendUntrackedInput = useCallback((data: string) => {
    if (readOnlyRef.current) return;
    if (multiExecActiveRef.current) {
      onInputBroadcastRef.current?.(data);
    }
    sendTerminalInput(data);
  }, [sendTerminalInput]);

  const acceptInlineSuggestion = useCallback((): boolean => {
    if (!suggestionsActiveRef.current) return false;
    const term = termRef.current;
    if (!term || term.buffer.active.type === "alternate") return false;
    const suggestion = suggestionRef.current;
    const pending = pendingRef.current;
    if (!suggestion || !pending || suggestion.length <= pending.length) return false;
    if (invalidatedRef.current) return false;
    if (!ghostVisibleRef.current) return false;

    const suffix = suggestion.slice(pending.length);
    if (suffix.length === 0) return false;

    sendUntrackedInput(suffix);

    pendingRef.current = suggestion;
    invalidatedRef.current = false;
    suggestionRef.current = null;
    refreshSuggestion();
    bumpGhost();
    return true;
  }, [sendUntrackedInput, refreshSuggestion, bumpGhost]);

  const extendTerminalBlockSelectionByKeyboard = useCallback((key: string) => {
    const term = termRef.current;
    if (!term) return false;
    const current = blockSelectionRef.current;
    const cursor = current?.focus ?? terminalCursorCell(term);
    if (!cursor) return false;

    const anchor = current?.anchor ?? cursor;
    const nextFocus: TerminalBlockSelectionCell = { ...cursor };
    if (key === "ArrowUp") nextFocus.row -= 1;
    if (key === "ArrowDown") nextFocus.row += 1;
    if (key === "ArrowLeft") nextFocus.col -= 1;
    if (key === "ArrowRight") nextFocus.col += 1;
    nextFocus.row = Math.max(0, Math.min(term.buffer.active.length - 1, nextFocus.row));
    nextFocus.col = Math.max(0, Math.min(term.cols - 1, nextFocus.col));

    term.clearSelection();
    const next = { anchor, focus: nextFocus };
    updateTerminalBlockSelection(next);
    showTerminalSelectionToolbar(collectTerminalBlockSelectionText(term, next));
    return true;
  }, [showTerminalSelectionToolbar, updateTerminalBlockSelection]);

  const isMac = typeof navigator !== "undefined" && /mac/i.test(navigator.platform);
  const effectiveReadOnly = readOnly || inputLocked;
  const { handleShortcutKey } = useTerminalShortcuts({
    setFullscreen,
    extendTerminalBlockSelectionByKeyboard,
    isMac,
    writeBroadcastInput,
    blockSelectionRef,
    clearTerminalBlockSelection,
    isLocal,
    supportsShellTools,
    readOnlyRef,
    termRef,
    setPaletteOpen,
    aiCommandRewriteEnabled,
    isLocalPowerShell,
    setAiRewriteOpen,
    getActiveTerminalSelectionText,
    copySelection,
    suppressNativePasteUntilRef,
    pasteFromClipboard,
    openSearch,
    saveBufferToFile,
    gitToggle,
    increaseFontSize,
    decreaseFontSize,
    resetFontSize,
    executeMacro,
    searchOpen,
    closeSearch,
    acceptInlineSuggestion,
  });
  const { handleTerminalContextMenu } = useTerminalContextMenu({
    getActiveTerminalSelectionText,
    isMac,
    themeName,
    t,
    copySelection,
    copyAll,
    copyFormattedSelection,
    pasteFromClipboard,
    effectiveReadOnly,
    openSearch,
    gitToggle,
    gitState,
    increaseFontSize,
    decreaseFontSize,
    resetFontSize,
    fontFamily,
    fontSize,
    commitTerminalProfilePatch,
    saveCurrentAppearanceAsTerminalDefault,
    saveCurrentProfileAsTerminalDefault,
    resetOutput,
    clearScrollback,
    renameTerminal,
    tabId,
    showScrollbar,
    fullscreen,
    setFullscreen,
    readOnly,
    syntaxMode,
    setSyntaxModeAndFocus,
    executeMacro,
    lastMacroRef,
    macroRecording,
    toggleMacroRecording,
    loggingActive,
    toggleOutputRecording,
    saveBufferToFile,
    startZmodemSend,
    zmodemState,
    setSettingsDialogOpen,
    sendSpecialSignal,
    setEventLogOpen,
    termRef,
    setStatusMessage,
    fontLigatures,
    contextMenu,
    rightClickBehavior,
  });
  const { handleTerminalMouseDownCapture, handleTerminalMouseUpCapture, handleMiddleClick } = useTerminalPointer({
    readOnlyRef,
    middleClickSelectionRef,
    setStatusMessage,
    getActiveTerminalSelectionText,
    writeBroadcastInput,
    termRef,
    focusTerminal,
    pasteFromClipboard,
    lastMacMiddlePasteAtRef,
    blockSelectionTextRef,
    copyOnSelectRef,
    writeClipboardText,
    showTerminalSelectionToolbar,
    containerRef,
    updateTerminalBlockSelection,
    setSelectionToolbar,
    isMac,
    cancelPendingSearch,
    clearTerminalBlockSelection,
    suppressNativePasteUntilRef,
  });

  useEffect(() => {
    readOnlyRef.current = effectiveReadOnly;
  }, [effectiveReadOnly]);

  useEffect(() => {
    if (initialCwd) latestCwdRef.current = initialCwd;
  }, [initialCwd]);

  useEffect(() => {
    if (cwdRequestToken === 0 || cwdRequestToken === lastCwdRequestTokenRef.current) return;
    lastCwdRequestTokenRef.current = cwdRequestToken;
    requestTerminalCwd();
  }, [cwdRequestToken, requestTerminalCwd]);

  useEffect(() => {
    loggingActiveRef.current = loggingActive;
  }, [loggingActive]);

  useEffect(() => {
    copyOnSelectRef.current = copyOnSelect;
  }, [copyOnSelect]);

  useEffect(() => {
    allowRemoteOsc52ClipboardRef.current = allowRemoteOsc52Clipboard;
  }, [allowRemoteOsc52Clipboard]);

  useEffect(() => {
    if (!terminalProfile) {
      appliedTerminalProfileSignatureRef.current = null;
      return;
    }

    const signature = terminalProfileSignature(terminalProfile);
    if (appliedTerminalProfileSignatureRef.current === signature) return;
    appliedTerminalProfileSignatureRef.current = signature;
    initialProfileRef.current = terminalProfile;
    currentTerminalProfileRef.current = terminalProfile;

    setFontFamily(terminalProfile.fontFamily);
    setFontSize(terminalProfile.fontSize);
    setFontLigatures(terminalProfile.fontLigatures);
    setShowScrollbar(terminalProfile.showScrollbar);
    setWebglRenderer(terminalProfile.webglRenderer);
    setReadOnly(terminalProfile.readOnly);
    setThemeName(terminalProfile.theme || theme);
    setCursorStyle(terminalProfile.cursorStyle);
    setCursorBlink(terminalProfile.cursorBlink);
    setScrollback(terminalProfile.scrollback);
    setSyntaxMode(terminalProfile.syntaxMode);
    setRightClickBehavior(terminalProfile.rightClickBehavior);
    setCopyOnSelect(terminalProfile.copyOnSelect);
    setAllowRemoteOsc52Clipboard(terminalProfile.allowRemoteOsc52Clipboard);
    setLoggingActive(terminalProfile.loggingEnabled);
    setMultilinePasteConfirm(terminalProfile.multilinePasteConfirm);
    setInlineSuggestionsEnabled(terminalProfile.inlineSuggestions);
    setInlineSuggestionsMax(terminalProfile.inlineSuggestionsMax);
    setInlineSuggestionsSource(terminalProfile.inlineSuggestionsSource);
    setAiCommandRewriteEnabled(terminalProfile.aiCommandRewriteEnabled);
    setCommonCommands(terminalProfile.commonCommands);
  }, [terminalProfile, theme]);

  useEffect(() => {
    macroRecordingRef.current = macroRecording;
  }, [macroRecording]);


  // Initialize once for the lifetime of this tab. Visibility changes must not
  // dispose the terminal, otherwise PTY/SSH sessions reconnect on tab switch.
  useEffect(createTerminalSessionLifecycle({
    containerRef,
    initializedRef,
    automationInputSettlingRef,
    ssh,
    adoptedTerminalRef,
    sessionIdRef,
    pendingLocalDirectoryReportsRef,
    fontFamily,
    resolvePanelTheme,
    themeName,
    fontSize,
    cursorBlink,
    cursorStyle,
    scrollback,
    termRef,
    fitAddonRef,
    searchAddonRef,
    isComposingRef,
    compositionBufferRef,
    isMac,
    latestCwdRef,
    cwdCallbackRef,
    tabId,
    setTerminalRuntime,
    isLocalRef,
    lastRecordedLocalDirRef,
    historyRef,
    isLocal,
    allowRemoteOsc52ClipboardRef,
    setStatusMessage,
    onTaskExitRef,
    sendTerminalInput,
    imeGuardRef,
    installTerminalWebgl,
    fitVisibleTerminal,
    writeXtermInput,
    writeBinaryInput,
    handleShortcutKey,
    blockSelectionRef,
    copyOnSelectRef,
    writeClipboardText,
    showTerminalSelectionToolbar,
    setSelectionToolbar,
    setViewportVersion,
    panelRef,
    connectionStateRef,
    installSshCwdIntegrationRef,
    fallbackSearchRef,
    searchInputRef,
    setSearchMatches,
    setActiveSearchIndex,
    setSearchStatus,
    appendEvent,
    syncTerminalSize,
    sockscapTerminal,
    injectedInputEchoSuppressorRef,
    loggingActiveRef,
    outputLogRef,
    onOutputRef,
    setZmodemState,
    setZmodemProgress,
    zmodemSaveDirRef,
    selectZmodemSendFiles,
    focusTerminal,
    setConflictDialogState,
    pendingMfaRequestIdRef,
    setMfaPrompt,
    setRegisteredSessionId,
    zmodemRef,
    pendingRef,
    invalidatedRef,
    suggestionRef,
    bumpGhost,
    refreshSuggestion,
    onDetachedStateChangeRef,
    flushRecordedOutput,
    preserveSessionOnUnmountRef,
    sdkTaskEnvironmentRef,
    lastTerminalSizeSyncRef,
    setResolvedLocalShellId,
    onSessionReadyRef,
    scheduleTerminalFitAndSync,
    initialCwd,
    commandTerminal,
    onSessionLaunchFailedRef,
    reconnectSshRef,
    localShell,
    workspaceRootRef,
    injectedInputHoldRef,
    webglAddonRef,
  }), []);
  useTerminalViewport({
    webglRendererRef,
    webglRenderer,
    termRef,
    disposeTerminalWebgl,
    installTerminalWebgl,
    fontFamily,
    fontSize,
    resolvePanelTheme,
    themeName,
    cursorBlink,
    cursorStyle,
    scrollback,
    fitVisibleTerminal,
    visible,
    activeForShortcuts,
    searchOpen,
    focusTerminal,
    fullscreen,
    showScrollbar,
  });

  useEffect(() => {
    if (!activeForShortcuts) return;

    const handleKeyDown = (event: KeyboardEvent) => {
      const activeEl = document.activeElement;
      if (isEditableTarget(event.target, activeEl)) {
        return;
      }
      if (!isTerminalFocused(panelRef.current, activeEl)) {
        return;
      }

      if (handleShortcutKey(event) === false) {
        event.stopPropagation();
        event.stopImmediatePropagation();
      }
    };

    window.addEventListener("keydown", handleKeyDown, true);
    return () => window.removeEventListener("keydown", handleKeyDown, true);
  }, [activeForShortcuts, handleShortcutKey]);

  useEffect(() => {
    if (!visible) return;

    const el = panelRef.current;
    if (!el) return;

    const handleWheel = (event: WheelEvent) => {
      if (!event.ctrlKey) return;
      event.preventDefault();
      event.stopPropagation();
      if (event.deltaY < 0) {
        increaseFontSize();
      } else if (event.deltaY > 0) {
        decreaseFontSize();
      }
    };

    el.addEventListener("wheel", handleWheel, { capture: true, passive: false });
    return () => el.removeEventListener("wheel", handleWheel, { capture: true });
  }, [decreaseFontSize, increaseFontSize, visible]);

  // Own macOS native paste events instead of letting xterm.js handle them. The event
  // carries clipboardData for user-triggered paste (Cmd+V / menu Paste) without
  // invoking navigator.clipboard.readText(), so macOS WKWebView does not show
  // the native "Paste" confirmation popover. Capturing on the xterm container
  // keeps this scoped away from sibling inputs like the find bar.
  //
  // On Windows / Linux, preserve the previous behavior: suppress native paste
  // events and use the explicit terminal paste shortcuts/menu paths instead.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const onPaste = (event: ClipboardEvent) => {
      event.stopImmediatePropagation();
      event.preventDefault();
      if (!isMac) {
        return;
      }
      if (Date.now() < suppressNativePasteUntilRef.current) {
        return;
      }
      const text = event.clipboardData?.getData("text/plain") ?? "";
      if (!isLocal && onUploadLocalPathsRef.current) {
        void clipboardReadFiles()
          .then((paths) => {
            if (paths.length > 0) {
              return handleLocalFilePaths(paths);
            }
            void pasteTextIntoTerminal(text);
            return undefined;
          })
          .catch((err) => {
            setStatusMessage(err instanceof Error ? err.message : "Clipboard paste failed");
          });
        return;
      }
      void pasteTextIntoTerminal(text);
    };
    el.addEventListener("paste", onPaste, { capture: true });
    return () => el.removeEventListener("paste", onPaste, { capture: true });
  }, [handleLocalFilePaths, isLocal, isMac, pasteTextIntoTerminal, setStatusMessage]);

  const searchHighlights = useMemo(
    () => getVisibleSearchHighlights(
      termRef.current,
      panelRef.current,
      containerRef.current,
      searchMatches,
      activeSearchIndex,
    ),
    [activeSearchIndex, fontSize, fullscreen, searchMatches, showScrollbar, viewportVersion],
  );

  const keywordHighlights = useMemo(
    () => getVisibleKeywordHighlights(
      termRef.current,
      panelRef.current,
      containerRef.current,
      syntaxMode,
    ),
    [fontSize, fullscreen, showScrollbar, syntaxMode, viewportVersion],
  );

  const blockSelectionHighlights = useMemo(
    () => getVisibleTerminalBlockSelectionHighlights(
      termRef.current,
      panelRef.current,
      containerRef.current,
      blockSelection,
    ),
    [blockSelection, fontSize, fullscreen, showScrollbar, viewportVersion],
  );

  const inlineGhost = useMemo(
    () => computeInlineGhost(
      termRef.current,
      panelRef.current,
      containerRef.current,
      suggestionsActive,
      pendingRef.current,
      suggestionRef.current,
      invalidatedRef.current,
    ),
    // ghostTick bumps on pending/suggestion changes; viewportVersion on scroll/render.
    // fontSize/fullscreen/showScrollbar also force recompute on layout shifts.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [ghostTick, viewportVersion, suggestionsActive, fontSize, fullscreen, showScrollbar],
  );

  useEffect(() => {
    ghostVisibleRef.current = inlineGhost !== null;
  }, [inlineGhost]);

  const panelClasses = [
    "relative w-full h-full",
    fullscreen ? "fixed inset-0 z-[9000]" : "",
    showScrollbar ? "" : "terminal-hide-scrollbar",
    fontLigatures ? "terminal-font-ligatures" : "terminal-no-font-ligatures",
  ].filter(Boolean).join(" ");
  const resolvedTheme = resolvePanelTheme(themeName);

  // Register this terminal in the global registry so the AI Chat Drawer can
  // pull buffer context (`@terminal:last-N`) and push commands back into it
  // (the assistant's "Send to terminal" button on rendered code blocks).
  // Re-runs whenever the backend session id changes, since stale entries
  // would point at a closed pty.
  useEffect(() => {
    if (!tabId || !registeredSessionId) return;
    const unregister = registerTerminal({
      tabId,
      sessionId: registeredSessionId,
      title: tabTitle,
      isReady: () => {
        const liveTerm = termRef.current;
        return !!liveTerm
          && connectionStateRef.current === "connected"
          && !automationInputSettlingRef.current
          && terminalAtIdlePrompt(liveTerm);
      },
      localEnvironment: isLocal
        ? {
            platform: getAppPlatform(),
            shellId: resolvedLocalShellId ?? localShell?.id ?? null,
            shellName: localShell?.name ?? null,
            shellArgs: localShell?.args ?? [],
          }
        : null,
      getBufferText: () => {
        const t = termRef.current;
        return t ? getBufferText(t) : "";
      },
      getLastLines: (n: number) => {
        const t = termRef.current;
        return t ? getLastBufferLines(t, n) : "";
      },
      writeInput: (data: string) => {
        if (readOnlyRef.current) return;
        if (/[\r\n]/.test(data)) {
          const program = inferTerminalProgram(data.split(/[\r\n]/).find((line) => line.trim()) ?? "");
          if (program) {
            setTerminalRuntime(tabId, {
              state: "running",
              program,
              activitySource: "input-heuristic",
            });
          }
        }
        writeTerminal(registeredSessionId, encodeBase64(data)).catch(console.error);
      },
      runTask: (command: string, taskVariables) => {
        if (readOnlyRef.current) return;
        const sdkTaskVariables = Object.fromEntries(
          Object.entries(sdkTaskEnvironmentRef.current).map(([name, value]) => [
            name,
            { value, mode: "replace" as const },
          ]),
        ) satisfies TerminalTaskVariables;
        const task = renderTerminalTask(command, {
          platform: getAppPlatform(),
          shellId: resolvedLocalShellId ?? localShell?.id ?? null,
          shellName: localShell?.name ?? null,
        }, { ...sdkTaskVariables, ...taskVariables });
        const suppressor = createTaskStartOutputSuppressor(
          task.startMarker,
          task.displayCommand,
        );
        injectedInputEchoSuppressorRef.current = suppressor;
        const program = inferTerminalProgram(task.displayCommand);
        setTerminalRuntime(tabId, {
          state: "running",
          program: program ?? undefined,
          activitySource: "input-heuristic",
        });
        writeTerminal(
          registeredSessionId,
          encodeBase64(buildInteractiveCommandInput(task.input)),
        ).catch((err) => {
          if (injectedInputEchoSuppressorRef.current === suppressor) {
            injectedInputEchoSuppressorRef.current = null;
          }
          console.error(err);
        });
      },
      // Display-only echo (xterm.write): mirror Claude Code's captured-run
      // activity into this terminal as a read-only trace. Intentionally NOT
      // gated by readOnlyRef — it never reaches stdin, it only paints the
      // screen, so a read-only/locked session can still show what CC ran.
      writeEcho: (data: string) => {
        termRef.current?.write(data);
      },
    });
    // Mirror the tab → backend-session mapping to the backend so Claude Code's
    // server-side tools (run_captured / read_capture) can resolve this live
    // terminal by tab id — run_in_terminal reaches it via the frontend registry
    // above, but those tools index state.terminals directly. Best-effort; a miss
    // just degrades to the existing "no live terminal" behaviour.
    void ccTrackTerminal(tabId, registeredSessionId).catch(() => {});
    return () => {
      unregister();
      void ccUntrackTerminal(tabId, registeredSessionId).catch(() => {});
    };
  }, [isLocal, localShell?.args, localShell?.id, localShell?.name, resolvedLocalShellId, setTerminalRuntime, tabId, registeredSessionId, tabTitle]);

  return (
    <div
      ref={panelRef}
      data-testid="terminal-pane"
      data-terminal-active={activeForShortcuts || undefined}
      data-input-locked={inputLocked || undefined}
      className={panelClasses}
      style={{
        background: resolvedTheme.background ?? "#1d1f21",
        ...(isMultiExecTarget ? { borderTop: "2px solid var(--taomni-accent)" } : {}),
      }}
      onWheel={(event) => {
        if (!event.ctrlKey) return;
        event.preventDefault();
        if (event.deltaY < 0) {
          increaseFontSize();
        } else if (event.deltaY > 0) {
          decreaseFontSize();
        }
      }}
      onDragOver={handleTerminalDragOver}
      onDrop={handleTerminalDrop}
      onContextMenu={handleTerminalContextMenu}
      onMouseDownCapture={handleTerminalMouseDownCapture}
      onMouseUpCapture={handleTerminalMouseUpCapture}
      onAuxClick={handleMiddleClick}
    >
      <div ref={containerRef} className="terminal-host w-full h-full overflow-hidden" />

      <TabActions active={activeForShortcuts}>
        {sftpToggle && (
          <button
            type="button"
            data-testid="attached-sftp-toggle"
            onClick={sftpToggle.onToggle}
            title={sftpToggle.open ? t("terminal.sftpFloatingClose") : t("terminal.sftpFloatingOpen")}
            style={{
              ...FT_BUTTON_STYLE,
              ...(sftpToggle.open ? FT_BUTTON_ACTIVE_OVERRIDE : {}),
            }}
          >
            <FolderOpen size={14} />
            {t("terminal.sftpFloatingButtonLabel")}
          </button>
        )}
        {chatToggle && (
          <button
            type="button"
            data-testid="tab-chat-toggle"
            aria-label={chatToggle.open ? t("terminal.chatFloatingLabelClose") : t("terminal.chatFloatingLabelOpen")}
            onClick={chatToggle.onToggle}
            title={chatToggle.open ? t("terminal.chatFloatingTitleClose") : t("terminal.chatFloatingTitleOpen")}
            style={{
              ...FT_BUTTON_STYLE,
              ...(chatToggle.open ? FT_BUTTON_ACTIVE_OVERRIDE : {}),
            }}
          >
            <Bot size={14} />
            {t("terminal.chatFloatingButtonLabel")}
          </button>
        )}
        {detachToggle && (
          <button
            type="button"
            data-testid="terminal-detach"
            aria-label={t("rdp.detach")}
            title={t("rdp.detach")}
            onClick={detachToggle.onDetach}
            style={FT_ICON_BUTTON_STYLE}
          >
            <ExternalLink size={14} />
          </button>
        )}

        {detachedWindowControls && (
          <>
            <ScreenshotMenuButton />
            <button
              type="button"
              data-testid="detached-reattach"
              aria-label={t("rdp.reattach")}
              title={t("rdp.reattach")}
              onClick={() => {
                preserveSessionOnUnmountRef.current = true;
                detachedWindowControls.onReattach(collectReattachState());
              }}
              style={FT_BUTTON_STYLE}
            >
              <ExternalLink size={14} />
              <span>{t("rdp.reattach")}</span>
            </button>
            <button
              type="button"
              data-testid="detached-os-fullscreen"
              aria-label={t("rdp.osFullscreen")}
              title={t("rdp.osFullscreen")}
              onClick={detachedWindowControls.onToggleOsFullscreen}
              style={FT_ICON_BUTTON_STYLE}
            >
              {detachedWindowControls.osFullscreen ? <Minimize2 size={14} /> : <Maximize2 size={14} />}
            </button>
          </>
        )}
      </TabActions>

      {isMultiExecTarget && (
        <div
          className="absolute top-1 left-1 z-40 px-1.5 py-0.5 rounded pointer-events-none"
          style={{ background: "var(--taomni-accent)", color: "#fff", opacity: 0.85, fontSize: 10, fontWeight: 600 }}
        >
          ⊕ {t("terminal.multiExecBadge")}
        </div>
      )}

      {keywordHighlights.length > 0 && (
        <div className="absolute inset-0 z-20 pointer-events-none">
          {keywordHighlights.map((highlight) => (
            <div
              key={`kw-${highlight.row}-${highlight.col}-${highlight.kind}`}
              className={`terminal-keyword-hit terminal-keyword-${highlight.kind}`}
              style={{
                left: highlight.left,
                top: highlight.top,
                width: highlight.width,
                height: highlight.height,
              }}
            />
          ))}
        </div>
      )}

      {searchHighlights.length > 0 && (
        <div className="absolute inset-0 z-30 pointer-events-none">
          {searchHighlights.map((highlight) => (
            <div
              key={`${highlight.row}-${highlight.col}-${highlight.active ? "active" : "match"}`}
              className={highlight.active ? "terminal-search-hit terminal-search-hit-active" : "terminal-search-hit"}
              style={{
                left: highlight.left,
                top: highlight.top,
                width: highlight.width,
                height: highlight.height,
              }}
            />
          ))}
        </div>
      )}

      {blockSelectionHighlights.length > 0 && (
        <div className="absolute inset-0 z-[35] pointer-events-none">
          {blockSelectionHighlights.map((highlight) => (
            <div
              key={`block-${highlight.row}`}
              className="terminal-block-selection"
              style={{
                left: highlight.left,
                top: highlight.top,
                width: highlight.width,
                height: highlight.height,
              }}
            />
          ))}
        </div>
      )}

      {inlineGhost && (
        <div
          className="terminal-inline-ghost"
          aria-hidden
          style={{
            left: inlineGhost.left,
            top: inlineGhost.top,
            height: inlineGhost.height,
            maxWidth: inlineGhost.maxWidth,
            fontFamily,
            fontSize,
            lineHeight: `${inlineGhost.height}px`,
            color: resolvedTheme.foreground ?? "#eaeaea",
          }}
        >
          {inlineGhost.text}
        </div>
      )}

      {effectiveReadOnly && (
        <div
          data-testid={inputLocked ? "terminal-input-locked" : "terminal-read-only"}
          className="absolute right-3 bottom-3 z-40 px-2 py-1 rounded border bg-white/90 text-[11px] text-slate-700 shadow-sm pointer-events-none"
        >
          {inputLocked ? t("terminal.inputLocked") : t("terminal.readOnlyBadge")}
        </div>
      )}

      {searchOpen && (
        <div
          className="absolute right-3 top-3 z-50 flex items-center gap-1 rounded border border-slate-400 bg-white p-1 shadow-lg text-[12px]"
          onMouseDown={(event) => event.stopPropagation()}
          onClick={(event) => event.stopPropagation()}
          onContextMenu={(event) => event.stopPropagation()}
        >
          <input
            ref={searchInputRef}
            className="taomni-input h-7 w-56"
            value={searchValue}
            placeholder={t("terminal.findPlaceholder")}
            onChange={(event) => {
              const next = event.target.value;
              setSearchValue(next);
              fallbackSearchRef.current = { query: next.trim(), index: -1 };
              setSearchStatus("");
            }}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.preventDefault();
                closeSearch();
              } else if (event.key === "Enter") {
                event.preventDefault();
                runSearch(event.shiftKey ? "previous" : "next");
              }
            }}
          />
          <button className="taomni-btn h-7 px-2" type="button" onClick={() => runSearch("previous")}>
            {t("terminal.findPrev")}
          </button>
          <button className="taomni-btn h-7 px-2" type="button" onClick={() => runSearch("next")}>
            {t("terminal.findNext")}
          </button>
          <button className="taomni-btn h-7 px-2" type="button" onClick={closeSearch}>
            {t("terminal.findClose")}
          </button>
          {searchStatus && <span className="px-1 text-[11px] text-[#b22222]">{searchStatus}</span>}
        </div>
      )}

      {eventLogOpen && (
        <div
          data-testid="terminal-event-log"
          className="absolute right-4 bottom-4 z-50 w-[520px] max-w-[calc(100%-2rem)] max-h-[360px] rounded border border-slate-500 bg-white shadow-xl text-[12px] overflow-hidden"
          onMouseDown={(event) => event.stopPropagation()}
          onClick={(event) => event.stopPropagation()}
          onContextMenu={(event) => event.stopPropagation()}
        >
          <div className="h-8 flex items-center px-3 border-b bg-slate-100">
            <span className="font-semibold">{t("terminal.eventLogTitle")}</span>
            <button
              data-testid="terminal-event-log-close"
              className="taomni-btn ml-auto h-6 px-2"
              type="button"
              onClick={() => setEventLogOpen(false)}
            >
              {t("terminal.eventLogClose")}
            </button>
          </div>
          <div className="max-h-[320px] overflow-auto">
            {eventLog.length === 0 ? (
              <div className="p-3 text-slate-500">{t("terminal.eventLogEmpty")}</div>
            ) : (
              <table className="w-full border-collapse">
                <tbody>
                  {eventLog.map((entry) => (
                    <tr key={entry.id} className="border-b border-slate-100">
                      <td className="w-20 px-2 py-1 text-slate-500 taomni-mono">{entry.time}</td>
                      <td className="w-24 px-2 py-1 font-semibold">{entry.type}</td>
                      <td className="px-2 py-1">{entry.detail}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </div>
        </div>
      )}

      {zmodemState !== "idle" && (
        <div className="absolute left-1/2 top-4 z-50 -translate-x-1/2 flex items-center gap-3 rounded border border-slate-400 bg-white px-4 py-2 shadow-lg text-[12px]">
          <span className="font-semibold">
            {zmodemState === "receiving" ? t("terminal.zmodemReceiving") : t("terminal.zmodemSending")} {t("terminal.zmodemViaZmodem")}
          </span>
          {zmodemProgress && (
            <>
              <span className="text-slate-600 taomni-mono">{zmodemProgress.fileName}</span>
              <span className="text-slate-500">
                {formatZmodemBytes(zmodemProgress.bytesTransferred)}
                {zmodemProgress.fileSize > 0 && ` / ${formatZmodemBytes(zmodemProgress.fileSize)}`}
              </span>
              {zmodemProgress.fileSize > 0 && (
                <div className="w-32 h-2 rounded bg-slate-200 overflow-hidden">
                  <div
                    className="h-full bg-blue-500 transition-all"
                    style={{ width: `${Math.min(100, Math.round(zmodemProgress.bytesTransferred / zmodemProgress.fileSize * 100))}%` }}
                  />
                </div>
              )}
            </>
          )}
        </div>
      )}

      {contextMenu.render}
      {pasteConfirmDialog}
      {terminalDefaultsConfirmDialog}

      {settingsDialogOpen && (
        <CurrentTerminalSettingsDialog
          profile={currentTerminalProfileRef.current}
          onProfileChange={commitTerminalProfilePatch}
          onSaveAsDefault={() => {
            void saveCurrentProfileAsTerminalDefault();
          }}
          onClose={() => {
            setSettingsDialogOpen(false);
            focusTerminal();
          }}
        />
      )}

      {conflictDialogState && (
        <ZmodemConflictDialog
          fileName={conflictDialogState.fileName}
          hasMore={conflictDialogState.hasMore}
          mode={conflictDialogState.mode}
          onResolve={(action) => {
            setConflictDialogState(null);
            conflictDialogState.resolve(action);
          }}
        />
      )}

      {mfaPrompt && (
        <MfaPrompt
          host={ssh?.host ?? ""}
          username={ssh?.username ?? ""}
          request={mfaPrompt}
          onSubmit={(responses) => {
            void submitSshAuthResponse(mfaPrompt.requestId, responses).catch(() => {});
            pendingMfaRequestIdRef.current = null;
            setMfaPrompt(null);
            focusTerminal();
          }}
          onCancel={() => {
            void submitSshAuthResponse(mfaPrompt.requestId, null).catch(() => {});
            pendingMfaRequestIdRef.current = null;
            setMfaPrompt(null);
          }}
        />
      )}

      {isLocal && supportsShellTools && (
        <CommonCommandsPalette
          open={paletteOpen}
          historyHostKey={historyHostKey}
          userCommands={commonCommands}
          presets={WINDOWS_PRESET_COMMANDS}
          onPick={(cmd) => {
            setPaletteOpen(false);
            sendTerminalInput(cmd);
            focusTerminal();
          }}
          onClose={() => {
            setPaletteOpen(false);
            focusTerminal();
          }}
        />
      )}

      {supportsShellTools && aiRewriteOpen && !isLocalPowerShell && (
        <AiRewriteOverlay
          currentCommand={pendingRef.current}
          onAccept={(newCmd) => {
            setAiRewriteOpen(false);
            // Clear the current pending input and inject the rewritten command.
            // Send backspaces to clear the line, then inject the new command.
            const clearLine = "\x15"; // Ctrl+U clears the line in most shells
            sendTerminalInput(clearLine + newCmd);
            pendingRef.current = newCmd;
            invalidatedRef.current = false;
            refreshSuggestion();
            focusTerminal();
          }}
          onDismiss={() => {
            setAiRewriteOpen(false);
            focusTerminal();
          }}
        />
      )}

      <SelectionToolbar
        visible={!!selectionToolbar}
        rect={selectionToolbar?.rect ?? null}
        selectionText={selectionToolbar?.text ?? ""}
        onCopy={(text) => {
          void writeClipboardText(text, "");
          setSelectionToolbar(null);
        }}
        onSendToAi={(text) => {
          void attachToComposer(text);
          setSelectionToolbar(null);
        }}
        onExplain={(text) => {
          void explainSelection(text);
          setSelectionToolbar(null);
        }}
        onDismiss={() => setSelectionToolbar(null)}
      />
    </div>
  );
}












export { type SshConnectInfo, type CommandTerminalConnectInfo, type TerminalReattachState, type AdoptedTerminalSession, type DetachedTerminalWindowControls, type TerminalLocalPathUploadRequest, type TerminalBlockSelectionCell, type TerminalBlockSelection } from "./panel/types";












export { collectTerminalBlockSelectionText } from "./panel/buffer";
