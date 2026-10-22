import { useEffect } from "react";
import { readFiles as clipboardReadFiles } from "../../../lib/clipboard";
import { isEditableTarget, isTerminalFocused } from "../../../lib/terminal/keyboardGuards";
import { createTerminalSessionLifecycle } from "./sessionLifecycle";
import { terminalProfileSignature } from "./transfer";
import { useTerminalCommands } from "./useTerminalCommands";
import { useTerminalContextMenu } from "./useTerminalContextMenu";
import { useTerminalInteraction } from "./useTerminalInteraction";
import { useTerminalPanelState } from "./useTerminalPanelState";
import { useTerminalPointer } from "./useTerminalPointer";
import { useTerminalShortcuts } from "./useTerminalShortcuts";
import { useTerminalViewport } from "./useTerminalViewport";


export interface UseTerminalLifecycleContext {
  panel: ReturnType<typeof useTerminalPanelState>;
  inputLocked: boolean;
  commands: ReturnType<typeof useTerminalCommands>;
  interaction: ReturnType<typeof useTerminalInteraction>;
  gitToggle: { cwd: string | null; onOpen: () => void; } | undefined;
  tabId: string | undefined;
  initialCwd: string | undefined;
  cwdRequestToken: number;
  terminalProfile: import("../../../lib/terminalProfile").TerminalProfile | undefined;
  theme: string;
  ssh: import("./types").SshConnectInfo | undefined;
  sockscapTerminal: import("../../../types").SocksCapTerminalLaunchInfo | undefined;
  commandTerminal: import("./types").CommandTerminalConnectInfo | undefined;
  localShell: { id: string; name: string; args?: string[]; } | undefined;
  visible: boolean;
  activeForShortcuts: boolean;
}

export function useTerminalLifecycle(context: UseTerminalLifecycleContext) {
  const {
    panel,
    inputLocked,
    commands,
    interaction,
    gitToggle,
    tabId,
    initialCwd,
    cwdRequestToken,
    terminalProfile,
    theme,
    ssh,
    sockscapTerminal,
    commandTerminal,
    localShell,
    visible,
    activeForShortcuts,
  } = context;

  const isMac = typeof navigator !== "undefined" && /mac/i.test(navigator.platform);
  const effectiveReadOnly = panel.readOnly || inputLocked;
  const { handleShortcutKey } = useTerminalShortcuts({
    setFullscreen: panel.setFullscreen,
    extendTerminalBlockSelectionByKeyboard: commands.extendTerminalBlockSelectionByKeyboard,
    isMac,
    writeBroadcastInput: interaction.writeBroadcastInput,
    blockSelectionRef: panel.blockSelectionRef,
    clearTerminalBlockSelection: interaction.clearTerminalBlockSelection,
    isLocal: panel.isLocal,
    supportsShellTools: panel.supportsShellTools,
    readOnlyRef: panel.readOnlyRef,
    termRef: panel.termRef,
    setPaletteOpen: panel.setPaletteOpen,
    aiCommandRewriteEnabled: panel.aiCommandRewriteEnabled,
    isLocalPowerShell: interaction.isLocalPowerShell,
    setAiRewriteOpen: panel.setAiRewriteOpen,
    getActiveTerminalSelectionText: interaction.getActiveTerminalSelectionText,
    copySelection: interaction.copySelection,
    suppressNativePasteUntilRef: panel.suppressNativePasteUntilRef,
    pasteFromClipboard: interaction.pasteFromClipboard,
    openSearch: interaction.openSearch,
    saveBufferToFile: interaction.saveBufferToFile,
    gitToggle,
    increaseFontSize: commands.increaseFontSize,
    decreaseFontSize: commands.decreaseFontSize,
    resetFontSize: commands.resetFontSize,
    executeMacro: interaction.executeMacro,
    searchOpen: interaction.searchOpen,
    closeSearch: interaction.closeSearch,
    acceptInlineSuggestion: commands.acceptInlineSuggestion,
  });
  const { handleTerminalContextMenu } = useTerminalContextMenu({
    getActiveTerminalSelectionText: interaction.getActiveTerminalSelectionText,
    isMac,
    themeName: panel.themeName,
    t: panel.t,
    copySelection: interaction.copySelection,
    copyAll: interaction.copyAll,
    copyFormattedSelection: interaction.copyFormattedSelection,
    pasteFromClipboard: interaction.pasteFromClipboard,
    effectiveReadOnly,
    openSearch: interaction.openSearch,
    gitToggle,
    gitState: interaction.gitState,
    increaseFontSize: commands.increaseFontSize,
    decreaseFontSize: commands.decreaseFontSize,
    resetFontSize: commands.resetFontSize,
    fontFamily: panel.fontFamily,
    fontSize: panel.fontSize,
    commitTerminalProfilePatch: panel.commitTerminalProfilePatch,
    saveCurrentAppearanceAsTerminalDefault: commands.saveCurrentAppearanceAsTerminalDefault,
    saveCurrentProfileAsTerminalDefault: commands.saveCurrentProfileAsTerminalDefault,
    resetOutput: commands.resetOutput,
    clearScrollback: commands.clearScrollback,
    renameTerminal: commands.renameTerminal,
    tabId,
    showScrollbar: panel.showScrollbar,
    fullscreen: panel.fullscreen,
    setFullscreen: panel.setFullscreen,
    readOnly: panel.readOnly,
    syntaxMode: panel.syntaxMode,
    setSyntaxModeAndFocus: commands.setSyntaxModeAndFocus,
    executeMacro: interaction.executeMacro,
    lastMacroRef: panel.lastMacroRef,
    macroRecording: panel.macroRecording,
    toggleMacroRecording: interaction.toggleMacroRecording,
    loggingActive: panel.loggingActive,
    toggleOutputRecording: interaction.toggleOutputRecording,
    saveBufferToFile: interaction.saveBufferToFile,
    startZmodemSend: commands.startZmodemSend,
    zmodemState: panel.zmodemState,
    setSettingsDialogOpen: panel.setSettingsDialogOpen,
    sendSpecialSignal: commands.sendSpecialSignal,
    setEventLogOpen: panel.setEventLogOpen,
    termRef: panel.termRef,
    setStatusMessage: panel.setStatusMessage,
    fontLigatures: panel.fontLigatures,
    contextMenu: panel.contextMenu,
    rightClickBehavior: panel.rightClickBehavior,
  });
  const { handleTerminalMouseDownCapture, handleTerminalMouseUpCapture, handleMiddleClick } = useTerminalPointer({
    readOnlyRef: panel.readOnlyRef,
    middleClickSelectionRef: panel.middleClickSelectionRef,
    setStatusMessage: panel.setStatusMessage,
    getActiveTerminalSelectionText: interaction.getActiveTerminalSelectionText,
    writeBroadcastInput: interaction.writeBroadcastInput,
    termRef: panel.termRef,
    focusTerminal: interaction.focusTerminal,
    pasteFromClipboard: interaction.pasteFromClipboard,
    lastMacMiddlePasteAtRef: panel.lastMacMiddlePasteAtRef,
    blockSelectionTextRef: panel.blockSelectionTextRef,
    copyOnSelectRef: panel.copyOnSelectRef,
    writeClipboardText: interaction.writeClipboardText,
    showTerminalSelectionToolbar: interaction.showTerminalSelectionToolbar,
    containerRef: panel.containerRef,
    updateTerminalBlockSelection: interaction.updateTerminalBlockSelection,
    setSelectionToolbar: panel.setSelectionToolbar,
    isMac,
    cancelPendingSearch: interaction.cancelPendingSearch,
    clearTerminalBlockSelection: interaction.clearTerminalBlockSelection,
    suppressNativePasteUntilRef: panel.suppressNativePasteUntilRef,
  });

  useEffect(() => {
    panel.readOnlyRef.current = effectiveReadOnly;
  }, [effectiveReadOnly]);

  useEffect(() => {
    if (initialCwd) panel.latestCwdRef.current = initialCwd;
  }, [initialCwd]);

  useEffect(() => {
    if (cwdRequestToken === 0 || cwdRequestToken === panel.lastCwdRequestTokenRef.current) return;
    panel.lastCwdRequestTokenRef.current = cwdRequestToken;
    interaction.requestTerminalCwd();
  }, [cwdRequestToken, interaction.requestTerminalCwd]);

  useEffect(() => {
    panel.loggingActiveRef.current = panel.loggingActive;
  }, [panel.loggingActive]);

  useEffect(() => {
    panel.copyOnSelectRef.current = panel.copyOnSelect;
  }, [panel.copyOnSelect]);

  useEffect(() => {
    panel.allowRemoteOsc52ClipboardRef.current = panel.allowRemoteOsc52Clipboard;
  }, [panel.allowRemoteOsc52Clipboard]);

  useEffect(() => {
    if (!terminalProfile) {
      panel.appliedTerminalProfileSignatureRef.current = null;
      return;
    }

    const signature = terminalProfileSignature(terminalProfile);
    if (panel.appliedTerminalProfileSignatureRef.current === signature) return;
    panel.appliedTerminalProfileSignatureRef.current = signature;
    panel.initialProfileRef.current = terminalProfile;
    panel.currentTerminalProfileRef.current = terminalProfile;

    panel.setFontFamily(terminalProfile.fontFamily);
    panel.setFontSize(terminalProfile.fontSize);
    panel.setFontLigatures(terminalProfile.fontLigatures);
    panel.setShowScrollbar(terminalProfile.showScrollbar);
    panel.setWebglRenderer(terminalProfile.webglRenderer);
    panel.setReadOnly(terminalProfile.readOnly);
    panel.setThemeName(terminalProfile.theme || theme);
    panel.setCursorStyle(terminalProfile.cursorStyle);
    panel.setCursorBlink(terminalProfile.cursorBlink);
    panel.setScrollback(terminalProfile.scrollback);
    panel.setSyntaxMode(terminalProfile.syntaxMode);
    panel.setRightClickBehavior(terminalProfile.rightClickBehavior);
    panel.setCopyOnSelect(terminalProfile.copyOnSelect);
    panel.setAllowRemoteOsc52Clipboard(terminalProfile.allowRemoteOsc52Clipboard);
    panel.setLoggingActive(terminalProfile.loggingEnabled);
    panel.setMultilinePasteConfirm(terminalProfile.multilinePasteConfirm);
    panel.setInlineSuggestionsEnabled(terminalProfile.inlineSuggestions);
    panel.setInlineSuggestionsMax(terminalProfile.inlineSuggestionsMax);
    panel.setInlineSuggestionsSource(terminalProfile.inlineSuggestionsSource);
    panel.setAiCommandRewriteEnabled(terminalProfile.aiCommandRewriteEnabled);
    panel.setCommonCommands(terminalProfile.commonCommands);
  }, [terminalProfile, theme]);

  useEffect(() => {
    panel.macroRecordingRef.current = panel.macroRecording;
  }, [panel.macroRecording]);


  // Initialize once for the lifetime of this tab. Visibility changes must not
  // dispose the terminal, otherwise PTY/SSH sessions reconnect on tab switch.
  useEffect(createTerminalSessionLifecycle({
    containerRef: panel.containerRef,
    initializedRef: panel.initializedRef,
    automationInputSettlingRef: panel.automationInputSettlingRef,
    ssh,
    adoptedTerminalRef: panel.adoptedTerminalRef,
    sessionIdRef: panel.sessionIdRef,
    pendingLocalDirectoryReportsRef: interaction.pendingLocalDirectoryReportsRef,
    fontFamily: panel.fontFamily,
    resolvePanelTheme: panel.resolvePanelTheme,
    themeName: panel.themeName,
    fontSize: panel.fontSize,
    cursorBlink: panel.cursorBlink,
    cursorStyle: panel.cursorStyle,
    scrollback: panel.scrollback,
    termRef: panel.termRef,
    fitAddonRef: panel.fitAddonRef,
    searchAddonRef: panel.searchAddonRef,
    isComposingRef: panel.isComposingRef,
    compositionBufferRef: panel.compositionBufferRef,
    isMac,
    latestCwdRef: panel.latestCwdRef,
    cwdCallbackRef: panel.cwdCallbackRef,
    tabId,
    setTerminalRuntime: panel.setTerminalRuntime,
    isLocalRef: interaction.isLocalRef,
    lastRecordedLocalDirRef: interaction.lastRecordedLocalDirRef,
    historyRef: interaction.historyRef,
    isLocal: panel.isLocal,
    allowRemoteOsc52ClipboardRef: panel.allowRemoteOsc52ClipboardRef,
    setStatusMessage: panel.setStatusMessage,
    onTaskExitRef: panel.onTaskExitRef,
    sendTerminalInput: interaction.sendTerminalInput,
    imeGuardRef: panel.imeGuardRef,
    installTerminalWebgl: interaction.installTerminalWebgl,
    fitVisibleTerminal: interaction.fitVisibleTerminal,
    writeXtermInput: interaction.writeXtermInput,
    writeBinaryInput: interaction.writeBinaryInput,
    handleShortcutKey,
    blockSelectionRef: panel.blockSelectionRef,
    copyOnSelectRef: panel.copyOnSelectRef,
    writeClipboardText: interaction.writeClipboardText,
    showTerminalSelectionToolbar: interaction.showTerminalSelectionToolbar,
    setSelectionToolbar: panel.setSelectionToolbar,
    setViewportVersion: panel.setViewportVersion,
    panelRef: panel.panelRef,
    connectionStateRef: panel.connectionStateRef,
    installSshCwdIntegrationRef: panel.installSshCwdIntegrationRef,
    fallbackSearchRef: interaction.fallbackSearchRef,
    searchInputRef: panel.searchInputRef,
    setSearchMatches: interaction.setSearchMatches,
    setActiveSearchIndex: interaction.setActiveSearchIndex,
    setSearchStatus: interaction.setSearchStatus,
    appendEvent: interaction.appendEvent,
    syncTerminalSize: interaction.syncTerminalSize,
    sockscapTerminal,
    injectedInputEchoSuppressorRef: panel.injectedInputEchoSuppressorRef,
    loggingActiveRef: panel.loggingActiveRef,
    outputLogRef: panel.outputLogRef,
    onOutputRef: panel.onOutputRef,
    setZmodemState: panel.setZmodemState,
    setZmodemProgress: panel.setZmodemProgress,
    zmodemSaveDirRef: panel.zmodemSaveDirRef,
    selectZmodemSendFiles: commands.selectZmodemSendFiles,
    focusTerminal: interaction.focusTerminal,
    setConflictDialogState: panel.setConflictDialogState,
    pendingMfaRequestIdRef: panel.pendingMfaRequestIdRef,
    setMfaPrompt: panel.setMfaPrompt,
    setRegisteredSessionId: panel.setRegisteredSessionId,
    zmodemRef: panel.zmodemRef,
    pendingRef: interaction.pendingRef,
    invalidatedRef: interaction.invalidatedRef,
    suggestionRef: interaction.suggestionRef,
    bumpGhost: interaction.bumpGhost,
    refreshSuggestion: interaction.refreshSuggestion,
    onDetachedStateChangeRef: panel.onDetachedStateChangeRef,
    flushRecordedOutput: interaction.flushRecordedOutput,
    preserveSessionOnUnmountRef: panel.preserveSessionOnUnmountRef,
    sdkTaskEnvironmentRef: panel.sdkTaskEnvironmentRef,
    lastTerminalSizeSyncRef: panel.lastTerminalSizeSyncRef,
    setResolvedLocalShellId: interaction.setResolvedLocalShellId,
    onSessionReadyRef: panel.onSessionReadyRef,
    scheduleTerminalFitAndSync: interaction.scheduleTerminalFitAndSync,
    initialCwd,
    commandTerminal,
    onSessionLaunchFailedRef: panel.onSessionLaunchFailedRef,
    reconnectSshRef: panel.reconnectSshRef,
    localShell,
    workspaceRootRef: panel.workspaceRootRef,
    injectedInputHoldRef: interaction.injectedInputHoldRef,
    webglAddonRef: panel.webglAddonRef,
  }), []);
  useTerminalViewport({
    webglRendererRef: panel.webglRendererRef,
    webglRenderer: panel.webglRenderer,
    termRef: panel.termRef,
    disposeTerminalWebgl: interaction.disposeTerminalWebgl,
    installTerminalWebgl: interaction.installTerminalWebgl,
    fontFamily: panel.fontFamily,
    fontSize: panel.fontSize,
    resolvePanelTheme: panel.resolvePanelTheme,
    themeName: panel.themeName,
    cursorBlink: panel.cursorBlink,
    cursorStyle: panel.cursorStyle,
    scrollback: panel.scrollback,
    fitVisibleTerminal: interaction.fitVisibleTerminal,
    visible,
    activeForShortcuts,
    searchOpen: interaction.searchOpen,
    focusTerminal: interaction.focusTerminal,
    fullscreen: panel.fullscreen,
    showScrollbar: panel.showScrollbar,
  });

  useEffect(() => {
    if (!activeForShortcuts) return;

    const handleKeyDown = (event: KeyboardEvent) => {
      const activeEl = document.activeElement;
      if (isEditableTarget(event.target, activeEl)) {
        return;
      }
      if (!isTerminalFocused(panel.panelRef.current, activeEl)) {
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

    const el = panel.panelRef.current;
    if (!el) return;

    const handleWheel = (event: WheelEvent) => {
      if (!event.ctrlKey) return;
      event.preventDefault();
      event.stopPropagation();
      if (event.deltaY < 0) {
        commands.increaseFontSize();
      } else if (event.deltaY > 0) {
        commands.decreaseFontSize();
      }
    };

    el.addEventListener("wheel", handleWheel, { capture: true, passive: false });
    return () => el.removeEventListener("wheel", handleWheel, { capture: true });
  }, [commands.decreaseFontSize, commands.increaseFontSize, visible]);

  // Own macOS native paste events instead of letting xterm.js handle them. The event
  // carries clipboardData for user-triggered paste (Cmd+V / menu Paste) without
  // invoking navigator.clipboard.readText(), so macOS WKWebView does not show
  // the native "Paste" confirmation popover. Capturing on the xterm container
  // keeps this scoped away from sibling inputs like the find bar.
  //
  // On Windows / Linux, preserve the previous behavior: suppress native paste
  // events and use the explicit terminal paste shortcuts/menu paths instead.
  useEffect(() => {
    const el = panel.containerRef.current;
    if (!el) return;
    const onPaste = (event: ClipboardEvent) => {
      event.stopImmediatePropagation();
      event.preventDefault();
      if (!isMac) {
        return;
      }
      if (Date.now() < panel.suppressNativePasteUntilRef.current) {
        return;
      }
      const text = event.clipboardData?.getData("text/plain") ?? "";
      if (!panel.isLocal && panel.onUploadLocalPathsRef.current) {
        void clipboardReadFiles()
          .then((paths) => {
            if (paths.length > 0) {
              return interaction.handleLocalFilePaths(paths);
            }
            void interaction.pasteTextIntoTerminal(text);
            return undefined;
          })
          .catch((err) => {
            panel.setStatusMessage(err instanceof Error ? err.message : "Clipboard paste failed");
          });
        return;
      }
      void interaction.pasteTextIntoTerminal(text);
    };
    el.addEventListener("paste", onPaste, { capture: true });
    return () => el.removeEventListener("paste", onPaste, { capture: true });
  }, [interaction.handleLocalFilePaths, panel.isLocal, isMac, interaction.pasteTextIntoTerminal, panel.setStatusMessage]);
  return {
    handleTerminalContextMenu,
    handleTerminalMouseDownCapture,
    handleTerminalMouseUpCapture,
    handleMiddleClick,
    effectiveReadOnly,
  };
}
