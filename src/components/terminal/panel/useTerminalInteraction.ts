import { WebglAddon } from "@xterm/addon-webgl";
import { Terminal } from "@xterm/xterm";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { gitProbePath, gitSnapshot } from "../../../lib/git";
import { makeHostKey, useCommandHistory } from "../../../lib/history";
import { resizeTerminal } from "../../../lib/ipc";
import { getBufferText } from "./buffer";
import { currentTerminalSize, shouldUseTerminalWebgl } from "./policy";
import { CWD_QUERY_COMMAND, PS_CWD_QUERY_COMMAND } from "./protocol";
import { type TerminalEventLogEntry, type TerminalGitState, type TerminalReattachState } from "./types";
import { useTerminalClipboard } from "./useTerminalClipboard";
import { useTerminalInput } from "./useTerminalInput";
import { useTerminalPanelState } from "./useTerminalPanelState";
import { useTerminalRecording } from "./useTerminalRecording";
import { useTerminalSearchActions } from "./useTerminalSearchActions";
import { useTerminalSuggestions } from "./useTerminalSuggestions";


export interface UseTerminalInteractionContext {
  panel: ReturnType<typeof useTerminalPanelState>;
  commandTerminal: import("./types").CommandTerminalConnectInfo | undefined;
  ssh: import("./types").SshConnectInfo | undefined;
  localShell: { id: string; name: string; args?: string[]; } | undefined;
  sockscapTerminal: import("../../../types").SocksCapTerminalLaunchInfo | undefined;
  gitToggle: { cwd: string | null; onOpen: () => void; } | undefined;
  tabId: string | undefined;
  terminalProfile: import("../../../lib/terminalProfile").TerminalProfile | undefined;
  tabTitle: string;
}

export function useTerminalInteraction(context: UseTerminalInteractionContext) {
  const { panel, commandTerminal, ssh, localShell, sockscapTerminal, gitToggle, tabId, terminalProfile, tabTitle } = context;

  const syncTerminalSize = useCallback((force = false) => {
    const sid = panel.sessionIdRef.current;
    const term = panel.termRef.current;
    if (!sid || !term) return;

    const { cols, rows } = currentTerminalSize(term);
    const previous = panel.lastTerminalSizeSyncRef.current;
    if (!force && previous?.sessionId === sid && previous.cols === cols && previous.rows === rows) {
      return;
    }
    panel.lastTerminalSizeSyncRef.current = { sessionId: sid, cols, rows };
    resizeTerminal(sid, cols, rows).catch(() => {
      if (panel.lastTerminalSizeSyncRef.current?.sessionId === sid) {
        panel.lastTerminalSizeSyncRef.current = null;
      }
    });
  }, []);

  const fitVisibleTerminal = useCallback((forceSync = false) => {
    const el = panel.containerRef.current;
    const term = panel.termRef.current;
    const fitAddon = panel.fitAddonRef.current;
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
      if (!panel.termRef.current) return;
      window.requestAnimationFrame(() => {
        if (panel.termRef.current) fitVisibleTerminal(forceSync);
      });
    };
    run();
    window.setTimeout(run, 80);
    window.setTimeout(run, 300);
  }, [fitVisibleTerminal]);

  const focusTerminal = useCallback(() => {
    panel.termRef.current?.focus();
  }, []);

  const disposeTerminalWebgl = useCallback((term: Terminal | null) => {
    const record = panel.webglAddonRef.current;
    if (!record) return;

    panel.webglAddonRef.current = null;
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
    if (!shouldUseTerminalWebgl(panel.webglRendererRef.current) || panel.webglAddonRef.current) return;

    let addon: WebglAddon | null = null;
    let contextLossDisposable: { dispose: () => void; } | null = null;
    try {
      addon = new WebglAddon();
      const currentAddon = addon;
      contextLossDisposable = currentAddon.onContextLoss(() => {
        if (panel.webglAddonRef.current?.addon !== currentAddon) return;
        disposeTerminalWebgl(term);
        panel.setStatusMessage("Terminal WebGL renderer lost; using stable renderer");
      });
      term.loadAddon(currentAddon);
      panel.webglAddonRef.current = { addon: currentAddon, contextLossDisposable };
    } catch {
      contextLossDisposable?.dispose();
      try {
        addon?.dispose();
      } catch {
        /* WebGL not available. */
      }
    }
  }, [disposeTerminalWebgl, panel.setStatusMessage]);

  const collectReattachState = useCallback((): TerminalReattachState => {
    const term = panel.termRef.current;
    return {
      terminalSessionId: panel.sessionIdRef.current ?? undefined,
      snapshotText: term ? getBufferText(term) : undefined,
    };
  }, []);

  const appendEvent = useCallback((type: string, detail: string) => {
    const entry: TerminalEventLogEntry = {
      id: ++panel.eventIdRef.current,
      time: new Date().toLocaleTimeString(),
      type,
      detail,
    };
    panel.setEventLog((items) => [...items.slice(-199), entry]);
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
      panel.isLocal &&
      (resolvedLocalShellId
        ? (resolvedLocalShellId === "powershell" || resolvedLocalShellId === "windows-powershell")
        : (localShell?.id === "powershell" || localShell?.id === "windows-powershell")),
    [panel.isLocal, resolvedLocalShellId, localShell?.id],
  );
  const suggestionsActive =
    panel.supportsShellTools && panel.inlineSuggestionsEnabled && !isLocalPowerShell;
  const history = useCommandHistory(historyHostKey, panel.inlineSuggestionsMax);

  // Which command (if any) can probe this terminal's cwd via OSC 7. SSH and
  // POSIX local shells use the `printf` form; PowerShell uses a [Console]::Write
  // form; cmd.exe can't emit OSC 7 cleanly, so it has no probe. Resolved
  // reactively because the backend reports the real local shell on connect.
  const isLocalCmd = useMemo(
    () =>
      panel.isLocal &&
      (resolvedLocalShellId === "command-prompt" ||
        /cmd\.exe|command[\s-]?prompt/i.test(`${localShell?.id ?? ""} ${localShell?.name ?? ""}`)),
    [panel.isLocal, resolvedLocalShellId, localShell?.id, localShell?.name],
  );
  const cwdProbeCommand = useMemo<string | null>(() => {
    if (commandTerminal || sockscapTerminal) return null;
    if (!panel.isLocal) return CWD_QUERY_COMMAND; // SSH → remote POSIX shell.
    if (isLocalCmd) return null;
    if (isLocalPowerShell) return PS_CWD_QUERY_COMMAND;
    return CWD_QUERY_COMMAND; // bash/zsh/git-bash/WSL/Unix default.
  }, [panel.isLocal, isLocalCmd, isLocalPowerShell, sockscapTerminal]);
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
    if (!panel.isLocal || !gitToggle) {
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
  }, [gitToggle?.cwd, panel.isLocal]);
  const {
    trackPending,
    pendingRef,
    invalidatedRef,
    refreshSuggestion,
    suggestionsActiveRef,
    suggestionRef,
    ghostVisibleRef,
    bumpGhost,
    pendingLocalDirectoryReportsRef,
    isLocalRef,
    lastRecordedLocalDirRef,
    historyRef,
    ghostTick,
  } = useTerminalSuggestions({
    history,
    suggestionsActive,
    inlineSuggestionsSource: panel.inlineSuggestionsSource,
    isLocal: panel.isLocal,
    termRef: panel.termRef,
  });
  const { writeBroadcastInput, writeInput, sendTerminalInput, requestTerminalCwd, writeXtermInput, writeBinaryInput, injectedInputHoldRef } = useTerminalInput({
    injectedInputEchoSuppressorRef: panel.injectedInputEchoSuppressorRef,
    sessionIdRef: panel.sessionIdRef,
    readOnlyRef: panel.readOnlyRef,
    connectionStateRef: panel.connectionStateRef,
    macroRecordingRef: panel.macroRecordingRef,
    macroPlaybackRef: panel.macroPlaybackRef,
    macroBufferRef: panel.macroBufferRef,
    ssh,
    setStatusMessage: panel.setStatusMessage,
    tabId,
    setTerminalRuntime: panel.setTerminalRuntime,
    trackPending,
    multiExecActiveRef: panel.multiExecActiveRef,
    onInputBroadcastRef: panel.onInputBroadcastRef,
    imeGuardRef: panel.imeGuardRef,
    adoptedTerminalRef: panel.adoptedTerminalRef,
    reconnectSshRef: panel.reconnectSshRef,
    termRef: panel.termRef,
    pendingRef,
    isLocalPowerShell,
    invalidatedRef,
    refreshSuggestion,
    terminalProfile,
    cwdProbeCommandRef,
  });
  const {
    clearTerminalBlockSelection,
    updateTerminalBlockSelection,
    showTerminalSelectionToolbar,
    getActiveTerminalSelectionText,
    copySelection,
    pasteFromClipboard,
    copyAll,
    copyFormattedSelection,
    writeClipboardText,
    handleLocalFilePaths,
    pasteTextIntoTerminal,
    handleTerminalDragOver,
    handleTerminalDrop,
  } = useTerminalClipboard({
    setStatusMessage: panel.setStatusMessage,
    setSelectionToolbar: panel.setSelectionToolbar,
    containerRef: panel.containerRef,
    blockSelectionRef: panel.blockSelectionRef,
    termRef: panel.termRef,
    blockSelectionTextRef: panel.blockSelectionTextRef,
    setBlockSelection: panel.setBlockSelection,
    focusTerminal,
    resolvePanelTheme: panel.resolvePanelTheme,
    themeName: panel.themeName,
    fontFamily: panel.fontFamily,
    fontSize: panel.fontSize,
    readOnlyRef: panel.readOnlyRef,
    multilinePasteConfirm: panel.multilinePasteConfirm,
    confirmPaste: panel.confirmPaste,
    t: panel.t,
    writeBroadcastInput,
    isLocal: panel.isLocal,
    resolvedLocalShellId,
    localShell,
    appendEvent,
    onUploadLocalPathsRef: panel.onUploadLocalPathsRef,
    latestCwdRef: panel.latestCwdRef,
    panelRef: panel.panelRef,
  });
  const { saveBufferToFile, executeMacro, toggleMacroRecording, toggleOutputRecording, flushRecordedOutput } = useTerminalRecording({
    termRef: panel.termRef,
    tabTitle,
    appendEvent,
    setStatusMessage: panel.setStatusMessage,
    focusTerminal,
    outputLogRef: panel.outputLogRef,
    setLoggingActive: panel.setLoggingActive,
    setMacroRecording: panel.setMacroRecording,
    lastMacroRef: panel.lastMacroRef,
    macroBufferRef: panel.macroBufferRef,
    macroPlaybackRef: panel.macroPlaybackRef,
    writeInput,
  });
  const {
    openSearch,
    closeSearch,
    cancelPendingSearch,
    runSearch,
    setSearchStatus,
    setSearchMatches,
    setActiveSearchIndex,
    searchValue,
    fallbackSearchRef,
    searchOpen,
    searchMatches,
    activeSearchIndex,
    setSearchValue,
    searchStatus,
  } = useTerminalSearchActions({ searchAddonRef: panel.searchAddonRef, termRef: panel.termRef, clearTerminalBlockSelection, focusTerminal, searchInputRef: panel.searchInputRef });
  return {
    focusTerminal,
    fitVisibleTerminal,
    sendTerminalInput,
    writeInput,
    appendEvent,
    suggestionsActiveRef,
    suggestionRef,
    pendingRef,
    invalidatedRef,
    ghostVisibleRef,
    refreshSuggestion,
    bumpGhost,
    updateTerminalBlockSelection,
    showTerminalSelectionToolbar,
    writeBroadcastInput,
    clearTerminalBlockSelection,
    isLocalPowerShell,
    getActiveTerminalSelectionText,
    copySelection,
    pasteFromClipboard,
    openSearch,
    saveBufferToFile,
    executeMacro,
    searchOpen,
    closeSearch,
    copyAll,
    copyFormattedSelection,
    gitState,
    toggleMacroRecording,
    toggleOutputRecording,
    writeClipboardText,
    cancelPendingSearch,
    requestTerminalCwd,
    pendingLocalDirectoryReportsRef,
    isLocalRef,
    lastRecordedLocalDirRef,
    historyRef,
    installTerminalWebgl,
    writeXtermInput,
    writeBinaryInput,
    fallbackSearchRef,
    setSearchMatches,
    setActiveSearchIndex,
    setSearchStatus,
    syncTerminalSize,
    flushRecordedOutput,
    setResolvedLocalShellId,
    scheduleTerminalFitAndSync,
    injectedInputHoldRef,
    disposeTerminalWebgl,
    handleLocalFilePaths,
    pasteTextIntoTerminal,
    searchMatches,
    activeSearchIndex,
    suggestionsActive,
    ghostTick,
    resolvedLocalShellId,
    handleTerminalDragOver,
    handleTerminalDrop,
    collectReattachState,
    searchValue,
    setSearchValue,
    runSearch,
    searchStatus,
    historyHostKey,
  };
}
