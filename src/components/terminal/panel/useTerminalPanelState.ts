import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";
import { WebglAddon } from "@xterm/addon-webgl";
import { Terminal } from "@xterm/xterm";
import { useCallback, useEffect, useRef, useState } from "react";
import { useAppTheme } from "../../../lib/appTheme";
import { useT } from "../../../lib/i18n";
import { type SshAuthPromptPayload } from "../../../lib/ipc";
import { TerminalImeInputGuard } from "../../../lib/terminalImeGuard";
import { type InputEchoSuppressor } from "../../../lib/terminalOutputFilter";
import { loadTerminalDefaultProfile, resolveTerminalThemeWithSystem, type TerminalProfile, type TerminalSyntaxMode, type UserCommonCommand } from "../../../lib/terminalProfile";
import { ZmodemSession, type ConflictAction, type SendConflictAction, type ZmodemProgress, type ZmodemState } from "../../../lib/zmodem";
import { useAppStore } from "../../../stores/appStore";
import { useChatStore } from "../../../stores/chatStore";
import { useContextMenu } from "../../ContextMenu";
import { useConfirmDialog } from "../../sidebar/ConfirmDialog";
import { terminalProfileSignature } from "./transfer";
import { type TerminalBlockSelection, type TerminalConnectionState, type TerminalEventLogEntry, type TerminalReattachState } from "./types";


export interface UseTerminalPanelStateContext {
  onCwdChange: ((cwd: string) => void) | undefined;
  onSessionReady: ((sessionId: string) => void) | undefined;
  onSessionLaunchFailed: ((error: unknown) => void) | undefined;
  onOutput: (() => void) | undefined;
  onTaskExit: ((exitCode: number) => void) | undefined;
  onUploadLocalPaths: ((request: import("./types").TerminalLocalPathUploadRequest) => Promise<void> | void) | undefined;
  onInputBroadcast: ((data: string) => void) | undefined;
  onTerminalProfileChange: ((profile: TerminalProfile) => void) | undefined;
  onDetachedStateChange: ((state: TerminalReattachState) => void) | undefined;
  preserveSessionOnUnmount: boolean;
  adoptedTerminal: import("./types").AdoptedTerminalSession | undefined;
  workspaceRoot: string | undefined;
  multiExecActive: boolean | undefined;
  initialCwd: string | undefined;
  ssh: import("./types").SshConnectInfo | undefined;
  commandTerminal: import("./types").CommandTerminalConnectInfo | undefined;
  sockscapTerminal: import("../../../types").SocksCapTerminalLaunchInfo | undefined;
  terminalProfile: TerminalProfile | undefined;
  tabId: string | undefined;
  theme: string;
  cwdRequestToken: number;
}

export function useTerminalPanelState(context: UseTerminalPanelStateContext) {
  const {
    onCwdChange,
    onSessionReady,
    onSessionLaunchFailed,
    onOutput,
    onTaskExit,
    onUploadLocalPaths,
    onInputBroadcast,
    onTerminalProfileChange,
    onDetachedStateChange,
    preserveSessionOnUnmount,
    adoptedTerminal,
    workspaceRoot,
    multiExecActive,
    initialCwd,
    ssh,
    commandTerminal,
    sockscapTerminal,
    terminalProfile,
    tabId,
    theme,
    cwdRequestToken,
  } = context;
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
    rect: { top: number; left: number; right: number; bottom: number; };
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
    contextLossDisposable: { dispose: () => void; } | null;
  } | null>(null);
  const suppressNativePasteUntilRef = useRef(0);
  const middleClickSelectionRef = useRef("");
  const blockSelectionRef = useRef<TerminalBlockSelection | null>(null);
  const blockSelectionTextRef = useRef("");
  const lastMacMiddlePasteAtRef = useRef(0);
  const lastTerminalSizeSyncRef = useRef<{ sessionId: string; cols: number; rows: number; } | null>(null);
  const lastCwdRequestTokenRef = useRef(cwdRequestToken);
  return {
    sessionIdRef,
    termRef,
    lastTerminalSizeSyncRef,
    containerRef,
    fitAddonRef,
    webglAddonRef,
    webglRendererRef,
    setStatusMessage,
    eventIdRef,
    setEventLog,
    isLocal,
    supportsShellTools,
    inlineSuggestionsEnabled,
    inlineSuggestionsMax,
    inlineSuggestionsSource,
    injectedInputEchoSuppressorRef,
    readOnlyRef,
    connectionStateRef,
    macroRecordingRef,
    macroPlaybackRef,
    macroBufferRef,
    setTerminalRuntime,
    multiExecActiveRef,
    onInputBroadcastRef,
    imeGuardRef,
    adoptedTerminalRef,
    reconnectSshRef,
    setSelectionToolbar,
    blockSelectionRef,
    blockSelectionTextRef,
    setBlockSelection,
    resolvePanelTheme,
    themeName,
    fontFamily,
    fontSize,
    multilinePasteConfirm,
    confirmPaste,
    t,
    onUploadLocalPathsRef,
    latestCwdRef,
    panelRef,
    outputLogRef,
    setLoggingActive,
    setMacroRecording,
    lastMacroRef,
    searchAddonRef,
    searchInputRef,
    updateTabTitle,
    currentTerminalProfileRef,
    commitTerminalProfilePatch,
    confirmTerminalDefaults,
    zmodemRef,
    readOnly,
    setFullscreen,
    setPaletteOpen,
    aiCommandRewriteEnabled,
    setAiRewriteOpen,
    suppressNativePasteUntilRef,
    showScrollbar,
    fullscreen,
    syntaxMode,
    macroRecording,
    loggingActive,
    zmodemState,
    setSettingsDialogOpen,
    setEventLogOpen,
    fontLigatures,
    contextMenu,
    rightClickBehavior,
    middleClickSelectionRef,
    lastMacMiddlePasteAtRef,
    copyOnSelectRef,
    lastCwdRequestTokenRef,
    loggingActiveRef,
    copyOnSelect,
    allowRemoteOsc52ClipboardRef,
    allowRemoteOsc52Clipboard,
    appliedTerminalProfileSignatureRef,
    initialProfileRef,
    setFontFamily,
    setFontSize,
    setFontLigatures,
    setShowScrollbar,
    setWebglRenderer,
    setReadOnly,
    setThemeName,
    setCursorStyle,
    setCursorBlink,
    setScrollback,
    setSyntaxMode,
    setRightClickBehavior,
    setCopyOnSelect,
    setAllowRemoteOsc52Clipboard,
    setMultilinePasteConfirm,
    setInlineSuggestionsEnabled,
    setInlineSuggestionsMax,
    setInlineSuggestionsSource,
    setAiCommandRewriteEnabled,
    setCommonCommands,
    initializedRef,
    automationInputSettlingRef,
    cursorBlink,
    cursorStyle,
    scrollback,
    isComposingRef,
    compositionBufferRef,
    cwdCallbackRef,
    onTaskExitRef,
    setViewportVersion,
    installSshCwdIntegrationRef,
    onOutputRef,
    setZmodemState,
    setZmodemProgress,
    zmodemSaveDirRef,
    setConflictDialogState,
    pendingMfaRequestIdRef,
    setMfaPrompt,
    setRegisteredSessionId,
    onDetachedStateChangeRef,
    preserveSessionOnUnmountRef,
    sdkTaskEnvironmentRef,
    onSessionReadyRef,
    onSessionLaunchFailedRef,
    workspaceRootRef,
    webglRenderer,
    viewportVersion,
    blockSelection,
    registeredSessionId,
    eventLogOpen,
    eventLog,
    zmodemProgress,
    pasteConfirmDialog,
    terminalDefaultsConfirmDialog,
    settingsDialogOpen,
    conflictDialogState,
    mfaPrompt,
    paletteOpen,
    commonCommands,
    aiRewriteOpen,
    selectionToolbar,
    attachToComposer,
    explainSelection,
  };
}
