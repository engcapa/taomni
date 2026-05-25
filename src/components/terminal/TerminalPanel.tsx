import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent as ReactDragEvent,
  type MouseEvent as ReactMouseEvent,
  type MutableRefObject,
} from "react";
import { Terminal, type IBufferLine } from "@xterm/xterm";
import { FitAddon } from "@xterm/addon-fit";
import { WebglAddon } from "@xterm/addon-webgl";
import { SearchAddon } from "@xterm/addon-search";
import { WebLinksAddon } from "@xterm/addon-web-links";
import {
  loadGlobalTerminalProfile,
  parseSessionOptions,
  resolveTerminalTheme,
  type TerminalProfile,
  type TerminalSyntaxMode,
  type UserCommonCommand,
} from "../../lib/terminalProfile";
import {
  getSessionNetworkSettings,
  toNetworkSettingsPayload,
} from "../../lib/networkSettings";
import { TERMINAL_THEME_DEFINITIONS, resolveThemeId } from "../../lib/themes";
import {
  findFontName,
  getPrimaryFontName,
  isMonospaceFont,
  makeTerminalFontFamily,
  SAFE_TERMINAL_FONT_FALLBACKS,
  useSystemFonts,
} from "../../lib/systemFonts";
import { FontPickerPanel } from "./FontPickerPanel";
import {
  attachTerminalImeGuard,
  shouldUseLinuxImeGuard,
  TerminalImeInputGuard,
} from "../../lib/terminalImeGuard";
import {
  readText as clipboardReadText,
  writeText as clipboardWriteText,
  writeMultiFormat as clipboardWriteMultiFormat,
} from "../../lib/clipboard";
import {
  captureContainerCanvasesPng,
  captureXtermFullBuffer,
  captureXtermVisible,
  renderXtermVisibleToCanvas,
  type XtermCaptureTheme,
} from "../../lib/capture";
import CaptureToolbar from "../capture/CaptureToolbar";
import FloatingToolbar from "../floating-toolbar/FloatingToolbar";
import { Bot, FolderOpen } from "lucide-react";
import {
  createInputEchoSuppressor,
  type InputEchoSuppressor,
} from "../../lib/terminalOutputFilter";
import { makeHostKey, useCommandHistory } from "../../lib/history";
import {
  createTerminalSessionId,
  createLocalTerminal,
  createSshTerminal,
  writeTerminal,
  resizeTerminal,
  sendTerminalSignal,
  closeTerminal,
  listenTerminalExit,
  listenTerminalForwardError,
  encodeBase64,
  selectUploadFile,
  selectSaveDirectory,
  readStreamOpen,
  readStreamRead,
  readStreamClose,
  writeStreamOpen,
  writeStreamAppend,
  writeStreamClose,
  writeStreamAbort,
  checkFileExists,
  VAULT_LOCKED_EVENT,
  isVaultLockedError,
} from "../../lib/ipc";
import { getAppPlatform, isTauriRuntime } from "../../lib/runtime";
import { registerTerminal } from "../../lib/terminal/terminalRegistry";
import {
  ZmodemSession,
  type ZmodemState,
  type ZmodemProgress,
  type ZmodemSendFile,
  type ConflictAction,
  type SendConflictAction,
} from "../../lib/zmodem";
import { ZmodemConflictDialog } from "./ZmodemConflictDialog";
import { CommonCommandsPalette } from "./CommonCommandsPalette";
import { AiRewriteOverlay } from "./AiRewriteOverlay";
import { SelectionToolbar } from "./SelectionToolbar";
import { useChatStore } from "../../stores/chatStore";
import { useSuggestionSource } from "../../lib/terminal/aiSuggestionSource";
import { WINDOWS_PRESET_COMMANDS } from "../../lib/commonCommandsPresets";
import { useAppStore } from "../../stores/appStore";
import { useContextMenu, type MenuItem } from "../ContextMenu";
import {
  NATIVE_FILE_DROP_EVENT,
  type NativeFileDropDetail,
  droppedFilePaths,
  formatDroppedPathsForShell,
  isOsFileDrag,
  shellQuoteStyleForTerminalDrop,
} from "../../lib/osFileDrop";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import "@xterm/xterm/css/xterm.css";

export interface SshConnectInfo {
  /** Persisted session config id, if this terminal was opened from a
   *  saved session. Used so the SessionEditor can subscribe to runtime
   *  forward errors for the session it is editing. */
  sessionId?: string;
  host: string;
  port: number;
  username: string;
  authMethod: string;
  authData: string | null;
  optionsJson?: string;
}

interface TerminalPanelProps {
  tabId?: string;
  tabTitle?: string;
  theme?: string;
  ssh?: SshConnectInfo;
  localShell?: {
    id: string;
    name: string;
    args?: string[];
  };
  terminalProfile?: TerminalProfile;
  visible?: boolean;
  activeForShortcuts?: boolean;
  inputLocked?: boolean;
  onCwdChange?: (cwd: string) => void;
  /** Incremented by the parent when the SFTP panel explicitly asks for cwd. */
  cwdRequestToken?: number;
  /** Called once the backend terminal session ID is known (after connect). */
  onSessionReady?: (sessionId: string) => void;
  /** Called whenever the terminal receives output (for new-output badge). */
  onOutput?: () => void;
  /** Whether MultiExec broadcast mode is active globally. */
  multiExecActive?: boolean;
  /** Whether this terminal is a selected broadcast target (shows visual indicator). */
  isMultiExecTarget?: boolean;
  /** Called with user input when MultiExec is active; parent broadcasts to other terminals. */
  onInputBroadcast?: (data: string) => void;
  /** When set, the floating toolbar shows an SFTP toggle button. Only used
   *  for SSH terminals where the parent owns the attached SFTP sidebar. */
  sftpToggle?: {
    open: boolean;
    onToggle: () => void;
  };
  /** Floating-toolbar button for the AI chat thread bound to this tab. */
  chatToggle?: {
    open: boolean;
    onToggle: () => void;
  };
}

const DEFAULT_FONT_SIZE = 14;
const CWD_QUERY_COMMAND =
  " printf '\\033]7;file://%s%s\\033\\\\' \"${HOSTNAME:-localhost}\" \"${PWD}\"; : __newmob_cwd_sync_done";
const OSC52_MAX_DECODED_BYTES = 1024 * 1024;

interface SearchMatch {
  row: number;
  col: number;
  length: number;
}

interface KeywordHighlight extends SearchMatch {
  kind: "error" | "warning" | "success";
}

interface TerminalEventLogEntry {
  id: number;
  time: string;
  type: string;
  detail: string;
}

export function TerminalPanel({
  tabId,
  tabTitle = "Terminal",
  theme = "classic",
  ssh,
  localShell,
  terminalProfile,
  visible = true,
  activeForShortcuts = visible,
  inputLocked = false,
  onCwdChange,
  cwdRequestToken = 0,
  onSessionReady,
  onOutput,
  multiExecActive,
  isMultiExecTarget,
  onInputBroadcast,
  sftpToggle,
  chatToggle,
}: TerminalPanelProps) {
  const cwdCallbackRef = useRef<typeof onCwdChange>(onCwdChange);
  const onSessionReadyRef = useRef<typeof onSessionReady>(onSessionReady);
  const onOutputRef = useRef<typeof onOutput>(onOutput);
  const onInputBroadcastRef = useRef<typeof onInputBroadcast>(onInputBroadcast);
  const multiExecActiveRef = useRef(multiExecActive);
  useEffect(() => {
    cwdCallbackRef.current = onCwdChange;
    onSessionReadyRef.current = onSessionReady;
    onOutputRef.current = onOutput;
    onInputBroadcastRef.current = onInputBroadcast;
    multiExecActiveRef.current = multiExecActive;
  }, [onCwdChange, onSessionReady, onOutput, onInputBroadcast, multiExecActive]);
  const containerRef = useRef<HTMLDivElement>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const searchAddonRef = useRef<SearchAddon | null>(null);
  const sessionIdRef = useRef<string | null>(null);
  // Mirrors `sessionIdRef.current` as state so the registry-effect below
  // re-runs whenever the backend session id changes.
  const [registeredSessionId, setRegisteredSessionId] = useState<string | null>(null);
  const termRef = useRef<Terminal | null>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const initializedRef = useRef(false);
  const readOnlyRef = useRef(false);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const fallbackSearchRef = useRef<{ query: string; index: number }>({ query: "", index: -1 });
  const contextMenu = useContextMenu();
  const fontState = useSystemFonts();
  const setStatusMessage = useAppStore((s) => s.setStatusMessage);
  const updateTabTitle = useAppStore((s) => s.updateTabTitle);
  const attachToComposer = useChatStore((s) => s.attachToComposer);
  const explainSelection = useChatStore((s) => s.explainSelection);
  const initialProfileRef = useRef<TerminalProfile | null>(null);
  if (!initialProfileRef.current) {
    initialProfileRef.current = terminalProfile ?? loadGlobalTerminalProfile();
  }
  const initialProfile = initialProfileRef.current;
  const appliedTerminalProfileSignatureRef = useRef<string | null>(
    terminalProfile ? terminalProfileSignature(terminalProfile) : null,
  );

  const [fontFamily, setFontFamily] = useState(initialProfile.fontFamily);
  const [fontSize, setFontSize] = useState(initialProfile.fontSize);
  const [fontLigatures, setFontLigatures] = useState(initialProfile.fontLigatures);
  const [showScrollbar, setShowScrollbar] = useState(initialProfile.showScrollbar);
  const [readOnly, setReadOnly] = useState(initialProfile.readOnly);
  const [themeName, setThemeName] = useState(initialProfile.theme || theme);
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
  const [commonCommands, setCommonCommands] = useState<UserCommonCommand[]>(initialProfile.commonCommands);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [fullscreen, setFullscreen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  const [eventLogOpen, setEventLogOpen] = useState(false);
  const [searchValue, setSearchValue] = useState("");
  const [searchStatus, setSearchStatus] = useState("");
  const [searchMatches, setSearchMatches] = useState<SearchMatch[]>([]);
  const [activeSearchIndex, setActiveSearchIndex] = useState(-1);
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
  const outputLogRef = useRef("");
  const loggingActiveRef = useRef(loggingActive);
  const copyOnSelectRef = useRef(copyOnSelect);
  const allowRemoteOsc52ClipboardRef = useRef(allowRemoteOsc52Clipboard);
  const macroRecordingRef = useRef(macroRecording);
  const macroBufferRef = useRef("");
  const lastMacroRef = useRef("");
  const macroPlaybackRef = useRef(false);
  const eventIdRef = useRef(0);
  const imeGuardRef = useRef<TerminalImeInputGuard | null>(null);
  const injectedInputEchoSuppressorRef = useRef<InputEchoSuppressor | null>(null);
  const lastCwdRequestTokenRef = useRef(cwdRequestToken);
  const quickFontOptions = useMemo(() => {
    const available = fontState.fonts;
    const preferred = SAFE_TERMINAL_FONT_FALLBACKS
      .map((font) => findFontName(available, font))
      .filter((font): font is string => !!font);
    return preferred.length > 0 ? preferred : available.slice(0, 8);
  }, [fontState.fonts]);

  const fitVisibleTerminal = useCallback(() => {
    const el = containerRef.current;
    const term = termRef.current;
    const fitAddon = fitAddonRef.current;
    if (!el || !term || !fitAddon || el.clientWidth === 0 || el.clientHeight === 0) {
      return;
    }

    try {
      fitAddon.fit();
      term.refresh(0, term.rows - 1);
      const sid = sessionIdRef.current;
      if (sid) {
        resizeTerminal(sid, term.cols, term.rows).catch(() => {});
      }
    } catch {
      // Hidden tabs can briefly report invalid dimensions while switching.
    }
  }, []);

  const focusTerminal = useCallback(() => {
    termRef.current?.focus();
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
  const historyHostKey = useMemo(() => makeHostKey(ssh), [ssh]);
  const isLocal = !ssh;
  // Tracks which local shell the backend actually launched. Lets us suppress
  // inline history suggestions on shells that already provide their own
  // (PSReadLine on PowerShell). Resolved on connect — the prop only carries
  // the user's selection, which can be missing when opening a saved
  // LocalShell session, so we trust the backend's resolved id instead.
  const [resolvedLocalShellId, setResolvedLocalShellId] = useState<string | null>(null);
  const isLocalPowerShell = useMemo(
    () =>
      isLocal &&
      (resolvedLocalShellId === "powershell" || resolvedLocalShellId === "windows-powershell"),
    [isLocal, resolvedLocalShellId],
  );
  const suggestionsActive = inlineSuggestionsEnabled && !isLocalPowerShell;
  const history = useCommandHistory(historyHostKey, inlineSuggestionsMax);

  // Refs decouple the once-mounted xterm.onData callback from the live
  // history/enabled values. Without this, the initial writeXtermInput closure
  // captures the empty prewarm cache and never sees later state changes.
  const historyRef = useRef(history);
  const suggestionsActiveRef = useRef(suggestionsActive);
  const inlineSuggestionsSourceRef = useRef(inlineSuggestionsSource);
  useEffect(() => {
    historyRef.current = history;
    suggestionsActiveRef.current = suggestionsActive;
    inlineSuggestionsSourceRef.current = inlineSuggestionsSource;
  }, [history, suggestionsActive, inlineSuggestionsSource]);

  // AI suggestion source resolver (data sources 2 + 3).
  // The resolver caches its options on every render; passing a thunk for
  // recent history keeps it invalidation-free without triggering rerenders.
  const recentHistoryForSuggestion = useMemo(
    () => history.recent(5),
    // The history hook bumps a cache version internally on commit, but we
    // only want to pull a fresh snapshot for new keystrokes — depending on
    // history alone here is fine because match() is the keystroke trigger.
    [history],
  );
  const resolveSuggestion = useSuggestionSource({
    source: inlineSuggestionsSource,
    isLocal,
    recentHistory: recentHistoryForSuggestion,
  });

  // State shared between onData tracking and the ghost renderer.
  const pendingRef = useRef("");
  const invalidatedRef = useRef(false);
  const suggestionRef = useRef<string | null>(null);
  const [ghostTick, setGhostTick] = useState(0);
  const ghostVisibleRef = useRef(false);

  const bumpGhost = useCallback(() => setGhostTick((v) => v + 1), []);

  const refreshSuggestion = useCallback(() => {
    if (!suggestionsActiveRef.current || invalidatedRef.current || pendingRef.current === "") {
      if (suggestionRef.current !== null) {
        suggestionRef.current = null;
      }
      bumpGhost();
      return;
    }
    const prefix = pendingRef.current;
    const matches = historyRef.current.match(prefix, 1);
    const historyMatch = matches[0] && matches[0].length > prefix.length ? matches[0] : null;

    if (historyMatch !== null) {
      // Source 1 hit — use immediately.
      suggestionRef.current = historyMatch;
      bumpGhost();
      return;
    }

    // Source 1 miss — try sources 2/3 asynchronously.
    const source = inlineSuggestionsSourceRef.current;
    if (source === "history+path" || source === "history+path+ai") {
      void resolveSuggestion(prefix, null, (result) => {
        // Only apply if the prefix hasn't changed since we started.
        if (pendingRef.current === prefix && !invalidatedRef.current) {
          suggestionRef.current = result;
          bumpGhost();
        }
      });
    } else {
      suggestionRef.current = null;
      bumpGhost();
    }
  }, [bumpGhost, resolveSuggestion]);

  const invalidatePending = useCallback(() => {
    if (invalidatedRef.current && suggestionRef.current === null) return;
    invalidatedRef.current = true;
    suggestionRef.current = null;
    bumpGhost();
  }, [bumpGhost]);

  const trackPending = useCallback((data: string) => {
    if (!suggestionsActiveRef.current) return;

    // Bracketed paste: whole block is shell input, never a typed command.
    if (data.startsWith("\x1b[200~")) {
      invalidatePending();
      return;
    }

    // Defensive: large chunk with any control char → treat as paste, invalidate.
    if (data.length > 64) {
      invalidatePending();
      return;
    }

    let changed = false;
    for (let i = 0; i < data.length; i++) {
      const code = data.charCodeAt(i);

      // CR / LF → Enter: commit the actual command on screen (handles Tab
      // completion, history recall, etc.), fall back to tracked pending.
      if (code === 0x0d || code === 0x0a) {
        let committed: string | null = null;
        const term = termRef.current;
        if (term && term.buffer.active.type !== "alternate") {
          const fromBuffer = captureBufferCommand(term);
          if (fromBuffer) committed = fromBuffer;
        }
        if (!committed && pendingRef.current !== "" && !invalidatedRef.current) {
          committed = pendingRef.current;
        }
        if (committed) historyRef.current.commit(committed);
        pendingRef.current = "";
        invalidatedRef.current = false;
        changed = true;
        continue;
      }

      // Ctrl+C: cancel current line entirely, but re-enable suggestions immediately.
      if (code === 0x03) {
        pendingRef.current = "";
        invalidatedRef.current = false;
        changed = true;
        continue;
      }

      // Backspace / DEL.
      if (code === 0x08 || code === 0x7f) {
        if (!invalidatedRef.current && pendingRef.current.length > 0) {
          pendingRef.current = pendingRef.current.slice(0, -1);
          changed = true;
        }
        continue;
      }

      // Escape or any CSI-like sequence — arrows, Home/End, Tab completion, function
      // keys: give up on the current line until the next Enter.
      if (code === 0x1b || code === 0x09) {
        invalidatedRef.current = true;
        changed = true;
        // Skip rest of this data chunk; it's almost certainly a single escape seq.
        break;
      }

      // Other C0 control chars (Ctrl+A/E/U/W/K/L/R/...) → invalidate.
      if (code < 0x20) {
        invalidatedRef.current = true;
        changed = true;
        break;
      }

      // Printable: append unless we're already invalidated.
      if (!invalidatedRef.current) {
        pendingRef.current += data[i];
        changed = true;
      }
    }

    if (changed) refreshSuggestion();
  }, [invalidatePending, refreshSuggestion]);

  // Rerun suggestion matching whenever the live cache or the on/off toggles
  // change — this is what picks up a freshly-prewarmed history list.
  useEffect(() => {
    refreshSuggestion();
  }, [suggestionsActive, history, refreshSuggestion]);

  const sendTerminalInput = useCallback((data: string) => {
    const sid = sessionIdRef.current;
    if (!sid || readOnlyRef.current) return;
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
    trackPending(data);
    if (multiExecActiveRef.current) {
      onInputBroadcastRef.current?.(data);
    }
    sendTerminalInput(data);
  }, [sendTerminalInput, trackPending]);

  const writeXtermInput = useCallback((data: string) => {
    if (readOnlyRef.current) return;
    const filtered = imeGuardRef.current?.filterTerminalData(data) ?? data;
    if (filtered === null) {
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

    trackPending(filtered);
    if (multiExecActiveRef.current) {
      onInputBroadcastRef.current?.(filtered);
    }
    sendTerminalInput(filtered);
  }, [sendTerminalInput, trackPending, refreshSuggestion, isLocalPowerShell, terminalProfile?.aiInlineQqRender]);

  const writeBinaryInput = useCallback((data: string) => {
    const sid = sessionIdRef.current;
    if (!sid || readOnlyRef.current) return;
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

    injectedInputEchoSuppressorRef.current = createInputEchoSuppressor(CWD_QUERY_COMMAND, 5000);
    writeTerminal(sid, encodeBase64(`${CWD_QUERY_COMMAND}\r`)).catch((err) => {
      if (sessionIdRef.current === sid) injectedInputEchoSuppressorRef.current = null;
      setStatusMessage(err instanceof Error ? err.message : "Terminal cwd request failed");
    });
  }, [setStatusMessage]);

  const writeClipboardText = useCallback(async (text: string, successMessage: string) => {
    if (!text) {
      setStatusMessage("Nothing to copy");
      return;
    }
    try {
      await clipboardWriteText(text);
      setStatusMessage(successMessage);
    } catch (err) {
      setStatusMessage(err instanceof Error ? err.message : "Clipboard copy failed");
    }
  }, [setStatusMessage]);

  const copySelection = useCallback(() => {
    const term = termRef.current;
    if (!term) return;
    void writeClipboardText(term.getSelection(), "Copied selection");
    focusTerminal();
  }, [focusTerminal, writeClipboardText]);

  const copyAll = useCallback(() => {
    const term = termRef.current;
    if (!term) return;
    void writeClipboardText(getBufferText(term), "Copied terminal buffer");
    focusTerminal();
  }, [focusTerminal, writeClipboardText]);

  const copyFormattedSelection = useCallback(async () => {
    const term = termRef.current;
    if (!term) return;
    const text = term.getSelection();
    if (!text) {
      setStatusMessage("Nothing to copy");
      return;
    }

    const resolvedTheme = resolveTerminalTheme(themeName);
    const html = `<pre style="margin:0;font-family:${escapeHtml(fontFamily)};font-size:${fontSize}px;background:${resolvedTheme.background ?? "#1d1f21"};color:${resolvedTheme.foreground ?? "#eaeaea"};white-space:pre-wrap;">${escapeHtml(text)}</pre>`;

    try {
      await clipboardWriteMultiFormat({ text, html });
      setStatusMessage("Copied formatted selection");
    } catch (err) {
      setStatusMessage(err instanceof Error ? err.message : "Formatted copy failed");
    } finally {
      focusTerminal();
    }
  }, [focusTerminal, fontFamily, fontSize, setStatusMessage, themeName, writeClipboardText]);

  const pasteFromClipboard = useCallback(async () => {
    if (readOnlyRef.current) {
      setStatusMessage("Terminal is read-only");
      return;
    }

    try {
      const text = (await clipboardReadText()) || window.prompt("Paste text") || "";
      if (!text) return;
      if (
        multilinePasteConfirm &&
        /\r?\n/.test(text) &&
        !window.confirm(`Paste ${text.split(/\r?\n/).length} lines into this terminal?`)
      ) {
        return;
      }
      writeBroadcastInput(formatPasteForTerminal(termRef.current, text));
      focusTerminal();
    } catch (err) {
      setStatusMessage(err instanceof Error ? err.message : "Clipboard paste failed");
    }
  }, [focusTerminal, multilinePasteConfirm, setStatusMessage, writeBroadcastInput]);

  const handleTerminalDragOver = useCallback((event: ReactDragEvent<HTMLDivElement>) => {
    if (!isOsFileDrag(event.dataTransfer)) return;
    event.preventDefault();
    if (readOnlyRef.current) {
      event.dataTransfer.dropEffect = "none";
      return;
    }
    event.dataTransfer.dropEffect = "copy";
  }, []);

  const insertDroppedPaths = useCallback((paths: string[]) => {
    if (readOnlyRef.current) {
      setStatusMessage("Terminal is read-only");
      focusTerminal();
      return;
    }

    const quoteStyle = shellQuoteStyleForTerminalDrop({
      isSsh: !isLocal,
      localShellId: resolvedLocalShellId ?? localShell?.id ?? null,
    });
    const text = formatDroppedPathsForShell(paths, quoteStyle);
    if (!text) return;

    writeBroadcastInput(formatPasteForTerminal(termRef.current, text));
    appendEvent("input", `Inserted ${paths.length} dropped file path${paths.length === 1 ? "" : "s"}`);
    setStatusMessage(`Inserted ${paths.length} file path${paths.length === 1 ? "" : "s"}`);
    focusTerminal();
  }, [appendEvent, focusTerminal, isLocal, localShell?.id, resolvedLocalShellId, setStatusMessage, writeBroadcastInput]);

  const handleTerminalDrop = useCallback((event: ReactDragEvent<HTMLDivElement>) => {
    if (!isOsFileDrag(event.dataTransfer)) return;
    event.preventDefault();
    event.stopPropagation();

    const paths = droppedFilePaths(event.dataTransfer);
    if (paths.length === 0) {
      setStatusMessage("Dropped file paths are not available in this environment");
      focusTerminal();
      return;
    }

    insertDroppedPaths(paths);
  }, [focusTerminal, insertDroppedPaths, setStatusMessage]);

  useEffect(() => {
    const handleNativeFileDrop = (event: Event) => {
      const detail = (event as CustomEvent<NativeFileDropDetail>).detail;
      if (!detail?.paths?.length) return;

      const panel = panelRef.current;
      const target = document.elementFromPoint(detail.clientX, detail.clientY);
      if (!panel || !target || !panel.contains(target)) return;

      insertDroppedPaths(detail.paths);
    };

    window.addEventListener(NATIVE_FILE_DROP_EVENT, handleNativeFileDrop);
    return () => window.removeEventListener(NATIVE_FILE_DROP_EVENT, handleNativeFileDrop);
  }, [insertDroppedPaths]);

  const saveBufferToFile = useCallback(() => {
    const term = termRef.current;
    if (!term) return;
    downloadTextFile(
      `${safeFilePart(tabTitle)}-${timestampFilePart()}.txt`,
      getBufferText(term),
      "text/plain",
    );
    appendEvent("export", "Saved terminal buffer to file");
    setStatusMessage("Saved terminal buffer");
    focusTerminal();
  }, [appendEvent, focusTerminal, setStatusMessage, tabTitle]);

  const flushRecordedOutput = useCallback((reason: string) => {
    if (!outputLogRef.current) {
      setStatusMessage("No recorded output to save");
      return;
    }
    downloadTextFile(
      `${safeFilePart(tabTitle)}-recording-${timestampFilePart()}.txt`,
      outputLogRef.current,
      "text/plain",
    );
    appendEvent("log", reason);
    outputLogRef.current = "";
    setStatusMessage("Saved terminal recording");
  }, [appendEvent, setStatusMessage, tabTitle]);

  const toggleOutputRecording = useCallback(() => {
    setLoggingActive((active) => {
      if (active) {
        flushRecordedOutput("Stopped output recording and saved file");
        return false;
      }
      outputLogRef.current = "";
      appendEvent("log", "Started output recording");
      setStatusMessage("Recording terminal output");
      return true;
    });
    focusTerminal();
  }, [appendEvent, flushRecordedOutput, focusTerminal, setStatusMessage]);

  const toggleMacroRecording = useCallback(() => {
    setMacroRecording((active) => {
      if (active) {
        lastMacroRef.current = macroBufferRef.current;
        appendEvent("macro", `Recorded ${lastMacroRef.current.length} input character${lastMacroRef.current.length === 1 ? "" : "s"}`);
        setStatusMessage(lastMacroRef.current ? "Macro recorded" : "Macro recording was empty");
        return false;
      }
      macroBufferRef.current = "";
      appendEvent("macro", "Started macro recording");
      setStatusMessage("Recording terminal macro");
      return true;
    });
    focusTerminal();
  }, [appendEvent, focusTerminal, setStatusMessage]);

  const executeMacro = useCallback(() => {
    const macro = lastMacroRef.current;
    if (!macro) {
      setStatusMessage("No macro recorded");
      return;
    }
    macroPlaybackRef.current = true;
    writeInput(macro);
    macroPlaybackRef.current = false;
    appendEvent("macro", `Executed macro (${macro.length} input character${macro.length === 1 ? "" : "s"})`);
    focusTerminal();
  }, [appendEvent, focusTerminal, setStatusMessage, writeInput]);

  const openSearch = useCallback(() => {
    setSearchOpen(true);
    setSearchStatus("");
  }, []);

  const closeSearch = useCallback(() => {
    setSearchOpen(false);
    setSearchStatus("");
    setSearchMatches([]);
    setActiveSearchIndex(-1);
    searchAddonRef.current?.clearDecorations();
    termRef.current?.clearSelection();
    focusTerminal();
  }, [focusTerminal]);

  const runSearch = useCallback((direction: "next" | "previous" = "next") => {
    const terminal = termRef.current;
    const term = (searchInputRef.current?.value ?? searchValue).trim();
    if (!terminal || !term) {
      searchAddonRef.current?.clearDecorations();
      setSearchMatches([]);
      setActiveSearchIndex(-1);
      setSearchStatus("");
      return;
    }

    searchAddonRef.current?.clearDecorations();
    const result = findAndSelectBufferText(
      terminal,
      term,
      direction,
      fallbackSearchRef,
    );
    if (result) {
      setSearchMatches(result.matches);
      setActiveSearchIndex(result.index);
      setSearchStatus(`Match ${result.index + 1}/${result.total}`);
    } else {
      setSearchMatches([]);
      setActiveSearchIndex(-1);
      setSearchStatus("No matches");
    }
  }, [searchValue]);

  const renameTerminal = useCallback(() => {
    if (!tabId) return;
    const nextTitle = window.prompt("Set terminal title", tabTitle);
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
    setFontSize((size) => Math.min(size + 1, 32));
  }, []);

  const decreaseFontSize = useCallback(() => {
    setFontSize((size) => Math.max(size - 1, 8));
  }, []);

  const resetFontSize = useCallback(() => {
    setFontSize(DEFAULT_FONT_SIZE);
  }, []);

  const setSyntaxModeAndFocus = useCallback((mode: TerminalSyntaxMode) => {
    setSyntaxMode(mode);
    focusTerminal();
  }, [focusTerminal]);

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

  const isMac = typeof navigator !== "undefined" && /mac/i.test(navigator.platform);
  const effectiveReadOnly = readOnly || inputLocked;

  const handleShortcutKey = useCallback((event: KeyboardEvent): boolean => {
    if (event.key === "F11") {
      event.preventDefault();
      setFullscreen((v) => !v);
      return false;
    }
    if (
      isLocal &&
      event.ctrlKey && event.shiftKey && !event.altKey && !event.metaKey &&
      event.key.toLowerCase() === "p"
    ) {
      if (readOnlyRef.current) return false;
      if (termRef.current?.buffer.active.type === "alternate") return false;
      event.preventDefault();
      setPaletteOpen(true);
      return false;
    }
    // Ctrl+K: AI command rewrite overlay (v2.2)
    if (
      aiCommandRewriteEnabled && !isLocalPowerShell &&
      event.ctrlKey && !event.shiftKey && !event.altKey && !event.metaKey &&
      event.key.toLowerCase() === "k"
    ) {
      if (readOnlyRef.current) return false;
      if (termRef.current?.buffer.active.type === "alternate") return false;
      event.preventDefault();
      setAiRewriteOpen(true);
      return false;
    }
    // Cross-platform copy/paste shortcuts
    if (isMac) {
      if (event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey && event.key.toLowerCase() === "c") {
        if (termRef.current?.hasSelection()) {
          event.preventDefault();
          copySelection();
          return false;
        }
        return true; // no selection: pass through (sends ETX)
      }
      if (event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey && event.key.toLowerCase() === "v") {
        if (!readOnlyRef.current) {
          event.preventDefault();
          void pasteFromClipboard();
          return false;
        }
        return true;
      }
    } else {
      // Windows / Linux
      if (event.ctrlKey && event.shiftKey && !event.altKey && !event.metaKey && event.key.toLowerCase() === "c") {
        if (termRef.current?.hasSelection()) {
          event.preventDefault();
          copySelection();
          return false;
        }
        return true; // no selection: pass through
      }
      if (event.ctrlKey && event.shiftKey && !event.altKey && !event.metaKey && event.key.toLowerCase() === "v") {
        if (!readOnlyRef.current) {
          event.preventDefault();
          void pasteFromClipboard();
          return false;
        }
        return true;
      }
    }
    if (event.shiftKey && event.key === "Insert") {
      event.preventDefault();
      void pasteFromClipboard();
      return false;
    }
    if (event.ctrlKey && event.shiftKey && event.key.toLowerCase() === "f") {
      event.preventDefault();
      openSearch();
      return false;
    }
    if (event.ctrlKey && event.shiftKey && event.key.toLowerCase() === "s") {
      event.preventDefault();
      saveBufferToFile();
      return false;
    }
    if (event.ctrlKey && (event.key === "+" || event.key === "=")) {
      event.preventDefault();
      increaseFontSize();
      return false;
    }
    if (event.ctrlKey && (event.key === "-" || event.key === "_")) {
      event.preventDefault();
      decreaseFontSize();
      return false;
    }
    if (event.ctrlKey && event.key === "0") {
      event.preventDefault();
      resetFontSize();
      return false;
    }
    if (event.ctrlKey && event.code === "Space") {
      event.preventDefault();
      executeMacro();
      return false;
    }
    if (searchOpen && event.key === "Escape") {
      event.preventDefault();
      closeSearch();
      return false;
    }
    if (
      (event.key === "ArrowRight" || event.key === "End") &&
      !event.ctrlKey && !event.altKey && !event.metaKey && !event.shiftKey
    ) {
      if (acceptInlineSuggestion()) {
        event.preventDefault();
        return false;
      }
    }
    return true;
  }, [
    acceptInlineSuggestion,
    closeSearch,
    decreaseFontSize,
    executeMacro,
    increaseFontSize,
    isLocal,
    openSearch,
    pasteFromClipboard,
    resetFontSize,
    saveBufferToFile,
    searchOpen,
  ]);

  const buildContextMenu = useCallback((): MenuItem[] => {
    const hasSelection = termRef.current?.hasSelection() ?? false;
    const copyShortcut = isMac ? "Cmd+C" : "Ctrl+Shift+C";
    const pasteShortcut = isMac ? "Cmd+V" : "Ctrl+Shift+V / Shift+Insert";

    return [
      { label: "Copy", shortcut: copyShortcut, onClick: copySelection, disabled: !hasSelection },
      { label: "Copy All", onClick: copyAll },
      { label: "Copy formatted text (HTML/RTF)", onClick: () => void copyFormattedSelection(), disabled: !hasSelection },
      { label: "Paste", shortcut: pasteShortcut, onClick: () => void pasteFromClipboard(), disabled: effectiveReadOnly },
      { label: "Find", shortcut: "Ctrl+Shift+F", onClick: openSearch },
      { label: "", separator: true },
      {
        label: "Font settings",
        children: [
          ...quickFontOptions.slice(0, 2).map((font) => ({
            label: `Use font "${font}"`,
            checked: getPrimaryFontName(fontFamily).toLowerCase() === font.toLowerCase(),
            onClick: () => setFontFamily(makeTerminalFontFamily(font)),
          })),
          {
            label: "More fonts...",
            customPanel: (
              <FontPickerPanel
                fonts={fontState.fonts}
                selectedFont={getPrimaryFontName(fontFamily)}
                onSelect={(font) => setFontFamily(makeTerminalFontFamily(font))}
              />
            ),
          },
          ...(quickFontOptions.length === 0 ? [{ label: "Loading fonts...", disabled: true }] : []),
          { label: "", separator: true },
          { label: "Display font ligatures", checked: fontLigatures, onClick: () => setFontLigatures((v) => !v) },
          { label: "", separator: true },
          { label: "Increase font size", shortcut: "Ctrl++ / Ctrl+WheelUp", onClick: increaseFontSize },
          { label: "Decrease font size", shortcut: "Ctrl+- / Ctrl+WheelDown", onClick: decreaseFontSize },
          { label: "Reset font size to default", shortcut: "Ctrl+0", onClick: resetFontSize },
        ],
      },
      {
        label: "Theme",
        children: TERMINAL_THEME_DEFINITIONS.map((definition) => ({
          label: definition.name,
          checked: resolveThemeId(themeName) === definition.id,
          onClick: () => setThemeName(definition.id),
        })),
      },
      {
        label: "Terminal display",
        children: [
          { label: "Reset terminal output", onClick: resetOutput },
          { label: "Clear terminal scrollback", onClick: clearScrollback },
          { label: "Set terminal title", onClick: renameTerminal, disabled: !tabId },
          { label: "Toggle terminal scrollbar", checked: showScrollbar, onClick: () => setShowScrollbar((v) => !v) },
          { label: "Fullscreen terminal", shortcut: "F11", checked: fullscreen, onClick: () => setFullscreen((v) => !v) },
          { label: "Read-only terminal", checked: readOnly, onClick: () => setReadOnly((v) => !v) },
        ],
      },
      {
        label: "Syntax highlighting",
        children: [
          { label: "Default", checked: syntaxMode === "default", onClick: () => setSyntaxModeAndFocus("default") },
          { label: "Error/Warning/Success keywords", checked: syntaxMode === "keywords", onClick: () => setSyntaxModeAndFocus("keywords") },
          { label: "Unix shell script", disabled: true },
          { label: "Cisco (network configuration)", disabled: true },
          { label: "Perl syntax", disabled: true },
          { label: "SQL syntax", disabled: true },
        ],
      },
      { label: "", separator: true },
      { label: "Execute macro", shortcut: "Ctrl+Space", onClick: executeMacro, disabled: !lastMacroRef.current },
      { label: macroRecording ? "Stop macro recording" : "Record new macro", checked: macroRecording, onClick: toggleMacroRecording },
      { label: loggingActive ? "Stop recording terminal output" : "Record terminal output to file", checked: loggingActive, onClick: toggleOutputRecording },
      { label: "Save to file", shortcut: "Ctrl+Shift+S", onClick: saveBufferToFile },
      { label: "Print", shortcut: "Ctrl+Shift+P", disabled: true },
      { label: "", separator: true },
      { label: "Send file using Z-modem", onClick: () => void startZmodemSend(), disabled: zmodemState !== "idle" },
      { label: "", separator: true },
      { label: "Change current terminal settings...", disabled: true },
      {
        label: "Special Command",
        children: [
          { label: "Break", disabled: true },
          { label: "SIGINT (Interrupt)", onClick: () => sendSpecialSignal("SIGINT", "\x03") },
          { label: "SIGTERM (Terminate)", onClick: () => sendSpecialSignal("SIGTERM") },
          { label: "SIGKILL (Kill)", onClick: () => sendSpecialSignal("SIGKILL") },
          { label: "SIGQUIT (Quit)", onClick: () => sendSpecialSignal("SIGQUIT", "\x1c") },
          { label: "SIGHUP (Hangup)", onClick: () => sendSpecialSignal("SIGHUP") },
          { label: "More signals", disabled: true },
          { label: "", separator: true },
          { label: "IGNORE message", disabled: true },
        ],
      },
      { label: "Event Log", onClick: () => setEventLogOpen(true) },
      { label: "", separator: true },
      {
        label: "AI: 解释最近的终端输出",
        onClick: () => {
          const term = termRef.current;
          if (!term) return;
          // Pull the last 50 lines from the buffer; if there's a selection,
          // prefer that. Both paths route to a fresh AI thread via
          // explainSelection (already redacts via chat::redact server-side).
          const selected = term.getSelection();
          const text = selected && selected.trim()
            ? selected
            : getLastBufferLines(term, 50);
          if (text.trim().length === 0) {
            setStatusMessage("Terminal buffer is empty");
            return;
          }
          void useChatStore.getState().explainSelection(text);
        },
      },
    ];
  }, [
    clearScrollback,
    copyAll,
    copyFormattedSelection,
    copySelection,
    decreaseFontSize,
    executeMacro,
    fontFamily,
    fontLigatures,
    fullscreen,
    increaseFontSize,
    openSearch,
    pasteFromClipboard,
    quickFontOptions,
    effectiveReadOnly,
    readOnly,
    renameTerminal,
    resetFontSize,
    resetOutput,
    saveBufferToFile,
    showScrollbar,
    syntaxMode,
    setSyntaxModeAndFocus,
    themeName,
    sendSpecialSignal,
    tabId,
    toggleMacroRecording,
    toggleOutputRecording,
    loggingActive,
    macroRecording,
    startZmodemSend,
    zmodemState,
  ]);

  const handleTerminalContextMenu = useCallback((event: ReactMouseEvent) => {
    if (rightClickBehavior === "paste") {
      event.preventDefault();
      event.stopPropagation();
      void pasteFromClipboard();
      return;
    }

    if (rightClickBehavior === "copy-or-paste") {
      event.preventDefault();
      event.stopPropagation();
      if (termRef.current?.hasSelection()) {
        copySelection();
      } else {
        void pasteFromClipboard();
      }
      return;
    }

    contextMenu.show(event, buildContextMenu());
  }, [
    buildContextMenu,
    contextMenu,
    copySelection,
    pasteFromClipboard,
    rightClickBehavior,
  ]);

  // Middle-click paste: if the terminal has a current selection, paste it at
  // the cursor; otherwise fall back to the system clipboard. Same behaviour
  // on Windows, macOS and Linux.
  const handleMiddleClick = useCallback((event: ReactMouseEvent) => {
    if (event.button !== 1) return;
    event.preventDefault();
    if (readOnlyRef.current) {
      setStatusMessage("Terminal is read-only");
      return;
    }
    const selection = termRef.current?.getSelection();
    if (selection) {
      writeBroadcastInput(formatPasteForTerminal(termRef.current, selection));
      focusTerminal();
      return;
    }
    void pasteFromClipboard();
  }, [focusTerminal, pasteFromClipboard, setStatusMessage, writeBroadcastInput]);

  useEffect(() => {
    readOnlyRef.current = effectiveReadOnly;
  }, [effectiveReadOnly]);

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

    setFontFamily(terminalProfile.fontFamily);
    setFontSize(terminalProfile.fontSize);
    setFontLigatures(terminalProfile.fontLigatures);
    setShowScrollbar(terminalProfile.showScrollbar);
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
  useEffect(() => {
    const el = containerRef.current;
    if (!el || initializedRef.current) return;

    initializedRef.current = true;

    let destroyed = false;
    let unlistenExit: UnlistenFn | null = null;
    let unlistenForwardError: UnlistenFn | null = null;
    let detachImeGuard: (() => void) | null = null;
    let resizeTimer: ReturnType<typeof setTimeout>;

    const primaryFont = getPrimaryFontName(fontFamily);
    const safeFontFamily = isMonospaceFont(primaryFont) ? fontFamily : makeTerminalFontFamily("Source Code Pro");

    const term = new Terminal({
      theme: resolveTerminalTheme(themeName),
      fontFamily: safeFontFamily,
      fontSize,
      cursorBlink,
      cursorStyle,
      scrollback,
    });
    termRef.current = term;

    const fitAddon = new FitAddon();
    fitAddonRef.current = fitAddon;
    term.loadAddon(fitAddon);

    const searchAddon = new SearchAddon();
    searchAddonRef.current = searchAddon;
    term.loadAddon(searchAddon);
    term.loadAddon(new WebLinksAddon());
    term.open(el);

    // OSC 7 — host writes its current working directory as `file://host/path`.
    // We listen for this so explicit SFTP "Sync" requests can learn the shell cwd.
    try {
      term.parser.registerOscHandler(7, (data) => {
        const cwd = parseOsc7(data);
        if (cwd) {
          cwdCallbackRef.current?.(cwd);
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

        if (!isLocal && !allowRemoteOsc52ClipboardRef.current) {
          setStatusMessage("Remote OSC 52 clipboard is disabled");
          return true;
        }
        if (!text) return true;

        void clipboardWriteText(text)
          .then(() => setStatusMessage("Copied via OSC 52"))
          .catch((err) => {
            setStatusMessage(err instanceof Error ? err.message : "OSC 52 clipboard copy failed");
          });
        return true;
      });
    } catch {
      /* parser API absent in some xterm builds */
    }

    if (shouldUseLinuxImeGuard()) {
      // Linux WebKitGTK can forward IME preedit text through xterm before the final commit.
      const guard = new TerminalImeInputGuard({ commit: sendTerminalInput });
      imeGuardRef.current = guard;
      detachImeGuard = attachTerminalImeGuard(el, guard);
    }

    if (shouldUseTerminalWebgl()) {
      try {
        term.loadAddon(new WebglAddon());
      } catch { /* WebGL not available */ }
    }

    fitVisibleTerminal();

    term.onData(writeXtermInput);
    term.onBinary(writeBinaryInput);
    term.onSelectionChange(() => {
      if (!copyOnSelectRef.current) return;
      const selected = term.getSelection();
      if (!selected) return;
      navigator.clipboard?.writeText(selected).catch(() => {});
    });
    term.attachCustomKeyEventHandler((event) => {
      if (event.type !== "keydown") return true;
      return handleShortcutKey(event);
    });
    const selectionDisposable = term.onSelectionChange(() => {
      if (copyOnSelectRef.current && term.hasSelection()) {
        void writeClipboardText(term.getSelection(), "");
      }

      // SelectionToolbar: show when there is a non-empty selection that
      // contains useful content (ignore single-char accidental drags).
      if (term.hasSelection()) {
        const text = term.getSelection();
        if (text && text.trim().length >= 2) {
          // The xterm.js `core` API isn't public; pick the bounding rect of
          // the visible terminal element and pin the toolbar to its top-right.
          const container = containerRef.current;
          if (container) {
            const rect = container.getBoundingClientRect();
            // Place above the visible terminal, anchored ~1/3 across.
            setSelectionToolbar({
              text,
              rect: {
                top: rect.top + 24,
                left: rect.left + rect.width / 3,
                right: rect.right,
                bottom: rect.bottom,
              },
            });
          }
        } else {
          setSelectionToolbar(null);
        }
      } else {
        setSelectionToolbar(null);
      }
    });
    const scrollDisposable = term.onScroll(() => setViewportVersion((v) => v + 1));
    const renderDisposable = term.onRender(() => setViewportVersion((v) => v + 1));
    const resizeDisposable = term.onResize(({ cols, rows }) => {
      setViewportVersion((v) => v + 1);
      appendEvent("resize", `${cols}x${rows}`);
    });

    const observer = new ResizeObserver(() => {
      clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        fitVisibleTerminal();
      }, 100);
    });
    observer.observe(el);

    const { cols, rows } = term;
    const sid = createTerminalSessionId();

    // Create the ZMODEM sentry before invoking the backend. The raw output
    // channel can receive early SSH banners before create*Terminal resolves.
    const zmodem = new ZmodemSession(
      (bytes) => {
        let b64 = "";
        for (let i = 0; i < bytes.length; i++) b64 += String.fromCharCode(bytes[i]);
        return writeTerminal(sid, btoa(b64)).catch((err) => {
          console.error(err);
          throw err;
        });
      },
      {
        onTerminalData: (data) => {
          if (destroyed) return;
          const suppressor = injectedInputEchoSuppressorRef.current;
          let filtered = suppressor ? suppressor.filter(data) : data;
          if (suppressor?.done) injectedInputEchoSuppressorRef.current = null;
          if (filtered.length === 0) return;
          if (loggingActiveRef.current) {
            outputLogRef.current += new TextDecoder().decode(filtered);
          }
          onOutputRef.current?.();
          term.write(filtered);
        },
        onStateChange: (state, progress) => {
          setZmodemState(state);
          setZmodemProgress(progress ?? null);
        },
        onProgress: (progress) => {
          setZmodemProgress({ ...progress });
        },
        onSelectSaveDir: async () => {
          const dir = await selectSaveDirectory(zmodemSaveDirRef.current);
          if (dir) zmodemSaveDirRef.current = dir;
          return dir;
        },
        onSelectSendFiles: async () => {
          appendEvent("zmodem", "Remote rz requested local files");
          setStatusMessage("Remote rz detected; choose local files to send");
          const files = await selectZmodemSendFiles();
          if (files.length === 0) {
            appendEvent("zmodem", "Send canceled");
            setStatusMessage("ZMODEM send canceled");
            focusTerminal();
            return null;
          }
          const names = files.map((f) => f.name).join(", ");
          setStatusMessage(`Sending ${files.length === 1 ? files[0].name : `${files.length} files (${names})`} via ZMODEM…`);
          focusTerminal();
          return files;
        },
        onCheckFileExists: checkFileExists,
        onFileConflict: (fileName, hasMore) =>
          new Promise<ConflictAction>((resolve) => {
            setConflictDialogState({ fileName, hasMore, mode: "receive", resolve });
          }),
        onSendConflict: (fileName, hasMore) =>
          new Promise<SendConflictAction>((resolve) => {
            setConflictDialogState({
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
          appendEvent("zmodem", `Transfer complete: ${fileName}`);
          setStatusMessage(`ZMODEM: ${fileName} transferred`);
          window.setTimeout(focusTerminal, 0);
        },
        onError: (message) => {
          appendEvent("error", `ZMODEM error: ${message}`);
          setStatusMessage(`ZMODEM error: ${message}`);
          window.setTimeout(focusTerminal, 0);
        },
      },
    );

    const connectPromise = ssh
      ? createSshTerminal(
          sid,
          ssh.host,
          ssh.port,
          ssh.username,
          ssh.authMethod,
          ssh.authData,
          cols,
          rows,
          (() => {
            const ns = getSessionNetworkSettings(ssh.optionsJson);
            return JSON.stringify(toNetworkSettingsPayload(ns));
          })(),
          (raw) => zmodem.consume(raw),
        ).then<{ sessionId: string; shellId: string | null }>((sessionId) => ({
          sessionId,
          shellId: null,
        }))
      : createLocalTerminal(
          sid,
          cols,
          rows,
          localShell?.id,
          localShell?.args,
          undefined,
          (raw) => zmodem.consume(raw),
        ).then(({ sessionId, shellId }) => ({ sessionId, shellId }));

    if (ssh) {
      appendEvent("connection", `Connecting to ${ssh.username}@${ssh.host}:${ssh.port}`);
      appendEvent("auth", `Using ${ssh.authMethod} authentication`);
      term.write(`\x1b[33mConnecting to ${ssh.username}@${ssh.host}:${ssh.port}...\x1b[0m\r\n`);
    } else {
      appendEvent("connection", `Starting ${localShell?.name ?? "local terminal"}`);
    }

    connectPromise
      .then(async ({ sessionId: connectedSid, shellId }) => {
        if (destroyed) {
          closeTerminal(connectedSid).catch(() => {});
          return;
        }
        sessionIdRef.current = connectedSid;
        setRegisteredSessionId(connectedSid);
        zmodemRef.current = zmodem;
        if (shellId) setResolvedLocalShellId(shellId);
        onSessionReadyRef.current?.(connectedSid);
        appendEvent("connection", `Connected (${connectedSid})`);
        if (ssh) {
          term.write(formatSshInfoBanner(ssh));
        }

        unlistenExit = await listenTerminalExit(connectedSid, () => {
          appendEvent("disconnect", "Terminal session ended");
          if (loggingActiveRef.current && outputLogRef.current) {
            flushRecordedOutput("Session ended; saved recorded output");
          }
          term.write("\r\n\x1b[33m[Session ended]\x1b[0m\r\n");
        });

        // Surface per-row local-forward errors (parse, bind, accept,
        // direct-tcpip open) in the same event log the user already sees
        // for connection / auth / disconnect events. Also re-broadcast
        // as a window-level CustomEvent keyed by the persisted session
        // config id so an open SessionEditor can show the failure
        // inline next to the offending forward row.
        unlistenForwardError = await listenTerminalForwardError(connectedSid, (err) => {
          appendEvent(
            "error",
            `Local forward ${err.local} → ${err.remote}: ${err.message}`,
          );
          if (ssh?.sessionId) {
            window.dispatchEvent(
              new CustomEvent("newmob:forward-error", {
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
      })
      .catch((err) => {
        console.error("Failed to create terminal:", err);
        appendEvent("error", `Connection failed: ${String(err)}`);
        term.write(`\x1b[31mConnection failed: ${err}\x1b[0m\r\n`);
      });

    return () => {
      destroyed = true;
      observer.disconnect();
      selectionDisposable.dispose();
      scrollDisposable.dispose();
      renderDisposable.dispose();
      resizeDisposable.dispose();
      clearTimeout(resizeTimer);
      unlistenExit?.();
      unlistenForwardError?.();
      detachImeGuard?.();
      if (loggingActiveRef.current && outputLogRef.current) {
        flushRecordedOutput("Terminal closed; saved recorded output");
      }
      if (sessionIdRef.current) closeTerminal(sessionIdRef.current).catch(() => {});
      term.dispose();
      termRef.current = null;
      fitAddonRef.current = null;
      searchAddonRef.current = null;
      sessionIdRef.current = null;
      setRegisteredSessionId(null);
      zmodemRef.current = null;
      imeGuardRef.current = null;
      initializedRef.current = false;
    };
  }, []);

  useEffect(() => {
    const term = termRef.current;
    if (!term) return;

    const primaryFont = getPrimaryFontName(fontFamily);
    const safeFontFamily = isMonospaceFont(primaryFont) ? fontFamily : makeTerminalFontFamily("Source Code Pro");

    term.options = {
      fontFamily: safeFontFamily,
      fontSize,
      theme: resolveTerminalTheme(themeName),
      cursorBlink,
      cursorStyle,
      scrollback,
    };
    window.setTimeout(() => requestAnimationFrame(fitVisibleTerminal), 0);
  }, [cursorBlink, cursorStyle, fitVisibleTerminal, fontFamily, fontSize, scrollback, themeName]);

  // When a hidden tab becomes visible again, re-measure xterm. Focus is
  // reserved for the active pane so split view does not race visible panes.
  useEffect(() => {
    if (!visible) return;

    let frame = 0;
    const timer = window.setTimeout(() => {
      frame = window.requestAnimationFrame(() => {
        fitVisibleTerminal();
        if (activeForShortcuts && !searchOpen) {
          focusTerminal();
        }
      });
    }, 50);

    return () => {
      window.clearTimeout(timer);
      if (frame) window.cancelAnimationFrame(frame);
    };
  }, [activeForShortcuts, fitVisibleTerminal, focusTerminal, fullscreen, searchOpen, showScrollbar, visible]);

  useEffect(() => {
    if (!activeForShortcuts) return;

    const handleKeyDown = (event: KeyboardEvent) => {
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

  // Suppress xterm.js's built-in paste handler. Every paste path that targets
  // the terminal is owned by our own code:
  //   * Ctrl+Shift+V / Cmd+V / Shift+Insert → handleShortcutKey → pasteFromClipboard
  //   * right-click / right-click paste behavior → pasteFromClipboard
  //   * middle-click → handleMiddleClick (selection-or-clipboard)
  // Letting xterm.js also handle the native `paste` event causes double-paste
  // on Linux/WebKitGTK, where middle-clicking the focused .xterm-helper-textarea
  // fires a native X11 PRIMARY-selection paste in addition to our onAuxClick.
  //
  // Capturing on the xterm container (not the whole panel) keeps this scoped
  // to the .xterm-helper-textarea and avoids breaking paste in sibling inputs
  // like the find bar. No-op on macOS / Windows: those platforms have no
  // native middle-click paste, and shortcut-driven paste is preventDefault'd
  // on keydown before any `paste` event fires.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const onPaste = (event: ClipboardEvent) => {
      event.stopImmediatePropagation();
      event.preventDefault();
    };
    el.addEventListener("paste", onPaste, { capture: true });
    return () => el.removeEventListener("paste", onPaste, { capture: true });
  }, []);

  useEffect(() => {
    if (!searchOpen) return;

    const frame = requestAnimationFrame(() => {
      searchInputRef.current?.focus();
      searchInputRef.current?.select();
    });

    return () => cancelAnimationFrame(frame);
  }, [searchOpen]);

  useEffect(() => {
    if (!searchOpen) return;
    if (!searchValue.trim()) {
      searchAddonRef.current?.clearDecorations();
      setSearchMatches([]);
      setActiveSearchIndex(-1);
      termRef.current?.clearSelection();
      setSearchStatus("");
      return;
    }

    const timer = window.setTimeout(() => runSearch("next"), 120);
    return () => window.clearTimeout(timer);
  }, [runSearch, searchOpen, searchValue]);

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
  const resolvedTheme = resolveTerminalTheme(themeName);

  // Keep data-terminal-text in sync so WebDriver / automation can read
  // terminal content without depending on xterm's canvas rendering.
  useEffect(() => {
    const el = panelRef.current;
    if (!el) return;
    const update = () => {
      const term = termRef.current;
      el.setAttribute("data-terminal-text", term ? getBufferText(term) : "");
    };
    update();
    const id = window.setInterval(update, 500);
    return () => window.clearInterval(id);
  }, []);

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
        writeTerminal(registeredSessionId, encodeBase64(data)).catch(console.error);
      },
    });
    return unregister;
  }, [tabId, registeredSessionId, tabTitle]);

  return (
    <div
      ref={panelRef}
      data-testid="terminal-pane"
      data-input-locked={inputLocked || undefined}
      className={panelClasses}
      style={{
        background: resolvedTheme.background ?? "#1d1f21",
        ...(isMultiExecTarget ? { borderTop: "2px solid var(--moba-accent)" } : {}),
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
      onAuxClick={handleMiddleClick}
    >
      <div ref={containerRef} className="w-full h-full" />

      <FloatingToolbar
        storageKey={`mob.terminal.toolbar.${ssh ? "ssh" : "local"}`}
        defaultTop={4}
        defaultRight={4}
        testId="terminal-floating-toolbar"
      >
        <CaptureToolbar
          filenamePrefix={`${safeFilePart(tabTitle)}`}
          getVisible={async () => {
            const term = termRef.current;
            const container = containerRef.current;
            if (!term) throw new Error("Terminal not ready");
            const theme: XtermCaptureTheme = {
              background: resolvedTheme.background ?? "#1d1f21",
              foreground: resolvedTheme.foreground ?? "#eaeaea",
              fontFamily,
              fontSize,
              lineHeight: 1.2,
            };
            try {
              return await captureXtermVisible(term, theme);
            } catch (err) {
              if (container) return await captureContainerCanvasesPng(container);
              throw err;
            }
          }}
          getFull={async () => {
            const term = termRef.current;
            if (!term) throw new Error("Terminal not ready");
            const theme: XtermCaptureTheme = {
              background: resolvedTheme.background ?? "#1d1f21",
              foreground: resolvedTheme.foreground ?? "#eaeaea",
              fontFamily,
              fontSize,
              lineHeight: 1.2,
            };
            return await captureXtermFullBuffer(term, theme);
          }}
          getScrollFrame={() => {
            const term = termRef.current;
            if (!term) return null;
            const theme: XtermCaptureTheme = {
              background: resolvedTheme.background ?? "#1d1f21",
              foreground: resolvedTheme.foreground ?? "#eaeaea",
              fontFamily,
              fontSize,
              lineHeight: 1.2,
            };
            return renderXtermVisibleToCanvas(term, theme);
          }}
          getGifFrame={() => {
            const term = termRef.current;
            if (!term) return null;
            const theme: XtermCaptureTheme = {
              background: resolvedTheme.background ?? "#1d1f21",
              foreground: resolvedTheme.foreground ?? "#eaeaea",
              fontFamily,
              fontSize,
              lineHeight: 1.2,
            };
            return renderXtermVisibleToCanvas(term, theme);
          }}
          onStatus={(msg) => setStatusMessage(msg)}
          compact
        />
        {sftpToggle && (
          <button
            type="button"
            data-testid="attached-sftp-toggle"
            onClick={sftpToggle.onToggle}
            title={sftpToggle.open ? "Hide SFTP browser" : "Open SFTP browser"}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 4,
              padding: "2px 8px",
              fontSize: 11,
              borderRadius: 4,
              background: sftpToggle.open ? "var(--moba-accent)" : "rgba(0,0,0,0.5)",
              color: sftpToggle.open ? "#fff" : "#ccc",
              border: "1px solid rgba(255,255,255,0.2)",
              cursor: "pointer",
            }}
          >
            <FolderOpen size={12} />
            SFTP
          </button>
        )}
        {chatToggle && (
          <button
            type="button"
            data-testid="tab-chat-toggle"
            aria-label={chatToggle.open ? "Close tab AI chat" : "Open tab AI chat"}
            onClick={chatToggle.onToggle}
            title={chatToggle.open ? "Hide tab AI chat (Ctrl+Shift+L)" : "Open tab AI chat (Ctrl+Shift+L)"}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 4,
              padding: "2px 8px",
              fontSize: 11,
              borderRadius: 4,
              background: chatToggle.open ? "var(--moba-accent)" : "rgba(0,0,0,0.5)",
              color: chatToggle.open ? "#fff" : "#ccc",
              border: "1px solid rgba(255,255,255,0.2)",
              cursor: "pointer",
            }}
          >
            <Bot size={12} />
            Chat
          </button>
        )}
      </FloatingToolbar>

      {isMultiExecTarget && (
        <div
          className="absolute top-1 left-1 z-40 px-1.5 py-0.5 rounded pointer-events-none"
          style={{ background: "var(--moba-accent)", color: "#fff", opacity: 0.85, fontSize: 10, fontWeight: 600 }}
        >
          ⊕ MultiExec
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
          {inputLocked ? "Input locked" : "Read-only"}
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
            className="moba-input h-7 w-56"
            value={searchValue}
            placeholder="Find"
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
          <button className="moba-btn h-7 px-2" type="button" onClick={() => runSearch("previous")}>
            Prev
          </button>
          <button className="moba-btn h-7 px-2" type="button" onClick={() => runSearch("next")}>
            Next
          </button>
          <button className="moba-btn h-7 px-2" type="button" onClick={closeSearch}>
            Close
          </button>
          {searchStatus && <span className="px-1 text-[11px] text-[#b22222]">{searchStatus}</span>}
        </div>
      )}

      {eventLogOpen && (
        <div
          className="absolute right-4 bottom-4 z-50 w-[520px] max-w-[calc(100%-2rem)] max-h-[360px] rounded border border-slate-500 bg-white shadow-xl text-[12px] overflow-hidden"
          onMouseDown={(event) => event.stopPropagation()}
          onClick={(event) => event.stopPropagation()}
          onContextMenu={(event) => event.stopPropagation()}
        >
          <div className="h-8 flex items-center px-3 border-b bg-slate-100">
            <span className="font-semibold">Event Log</span>
            <button className="moba-btn ml-auto h-6 px-2" type="button" onClick={() => setEventLogOpen(false)}>
              Close
            </button>
          </div>
          <div className="max-h-[320px] overflow-auto">
            {eventLog.length === 0 ? (
              <div className="p-3 text-slate-500">No terminal events yet.</div>
            ) : (
              <table className="w-full border-collapse">
                <tbody>
                  {eventLog.map((entry) => (
                    <tr key={entry.id} className="border-b border-slate-100">
                      <td className="w-20 px-2 py-1 text-slate-500 moba-mono">{entry.time}</td>
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
            {zmodemState === "receiving" ? "Receiving" : "Sending"} via Z-modem
          </span>
          {zmodemProgress && (
            <>
              <span className="text-slate-600 moba-mono">{zmodemProgress.fileName}</span>
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

      {isLocal && (
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

      {aiRewriteOpen && !isLocalPowerShell && (
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

function formatSshInfoBanner(ssh: SshConnectInfo): string {
  const options = parseSessionOptions(ssh.optionsJson);
  const compression = options.compression === true;
  const x11 = options.x11 !== false;
  const sshBrowser = typeof options.sshBrowser === "string" ? options.sshBrowser : "SFTP protocol (recommended)";
  const sshBrowserEnabled = sshBrowser !== "Disabled";
  const rows = [
    "NewMob SSH terminal",
    "SSH session to " + ssh.username + "@" + ssh.host,
    "Direct SSH      : " + checkMark(true),
    "SSH compression : " + checkMark(compression),
    "SSH-browser     : " + checkMark(sshBrowserEnabled) + (sshBrowserEnabled ? "  " + sshBrowser : ""),
    "X11-forwarding  : " + checkMark(x11) + (x11 ? "  (remote display is forwarded through SSH)" : ""),
    "",
    "For more info, edit SSH session advanced settings.",
  ];
  const width = Math.max(68, ...rows.map((row) => row.length + 4));
  const border = "+" + "-".repeat(width - 2) + "+";
  const body = rows.map((row) => "| " + row.padEnd(width - 4) + " |");
  return "\r\n" + [border, ...body, border].join("\r\n") + "\r\n";
}

function checkMark(enabled: boolean): string {
  return enabled ? "✓" : "✗";
}

function getBufferText(term: Terminal): string {
  const buffer = term.buffer.active;
  const lines: string[] = [];

  for (let i = 0; i < buffer.length; i++) {
    const line = buffer.getLine(i);
    if (!line) continue;

    const text = line.translateToString(true);
    if (line.isWrapped && lines.length > 0) {
      lines[lines.length - 1] += text;
    } else {
      lines.push(text);
    }
  }

  while (lines.length > 0 && lines[lines.length - 1] === "") {
    lines.pop();
  }

  return lines.join("\n");
}

function getLastBufferLines(term: Terminal, lineCount: number): string {
  const buffer = term.buffer.active;
  const total = buffer.length;
  const start = Math.max(0, total - lineCount);
  const lines: string[] = [];
  for (let i = start; i < total; i++) {
    const line = buffer.getLine(i);
    if (!line) continue;
    const text = line.translateToString(true);
    if (line.isWrapped && lines.length > 0) {
      lines[lines.length - 1] += text;
    } else {
      lines.push(text);
    }
  }
  while (lines.length > 0 && lines[lines.length - 1] === "") {
    lines.pop();
  }
  return lines.join("\n");
}

function findAndSelectBufferText(
  term: Terminal,
  query: string,
  direction: "next" | "previous",
  searchRef: MutableRefObject<{ query: string; index: number }>,
): { index: number; total: number; matches: SearchMatch[] } | null {
  const matches = collectBufferMatches(term, query);
  if (matches.length === 0) {
    return null;
  }

  const sameQuery = searchRef.current.query === query;
  let nextIndex = sameQuery ? searchRef.current.index : -1;

  if (nextIndex < 0) {
    nextIndex = firstVisibleMatchIndex(term, matches, direction);
  } else {
    nextIndex = direction === "next"
      ? (nextIndex + 1) % matches.length
      : (nextIndex - 1 + matches.length) % matches.length;
  }

  const match = matches[nextIndex];
  term.scrollToLine(Math.max(0, match.row - Math.floor(term.rows / 2)));
  term.select(match.col, match.row, match.length);
  term.refresh(0, term.rows - 1);
  searchRef.current = { query, index: nextIndex };
  return { index: nextIndex, total: matches.length, matches };
}

function collectBufferMatches(term: Terminal, query: string): SearchMatch[] {
  const buffer = term.buffer.active;
  const matches: SearchMatch[] = [];
  const needle = query.toLocaleLowerCase();

  for (let row = 0; row < buffer.length; row++) {
    const line = buffer.getLine(row);
    if (!line) continue;

    const { text, stringIndexToCell } = lineToSearchText(line);
    const haystack = text.toLocaleLowerCase();
    let stringIndex = haystack.indexOf(needle);
    while (stringIndex !== -1) {
      const startCell = stringIndexToCell[stringIndex];
      const lastCell = stringIndexToCell[stringIndex + Math.max(needle.length - 1, 0)];
      if (typeof startCell === "number" && typeof lastCell === "number") {
        const lastWidth = line.getCell(lastCell)?.getWidth() || 1;
        matches.push({
          row,
          col: startCell,
          length: Math.max(1, lastCell + lastWidth - startCell),
        });
      }
      stringIndex = haystack.indexOf(needle, stringIndex + Math.max(needle.length, 1));
    }
  }

  return matches;
}

function lineToSearchText(line: IBufferLine): { text: string; stringIndexToCell: number[] } {
  let text = "";
  const stringIndexToCell: number[] = [];

  for (let cellIndex = 0; cellIndex < line.length; cellIndex++) {
    const cell = line.getCell(cellIndex);
    if (!cell || cell.getWidth() === 0) continue;

    const chars = cell.getChars() || " ";
    for (let offset = 0; offset < chars.length; offset++) {
      stringIndexToCell[text.length + offset] = cellIndex;
    }
    text += chars;
  }

  const trimmedLength = text.trimEnd().length;
  return {
    text: text.slice(0, trimmedLength),
    stringIndexToCell: stringIndexToCell.slice(0, trimmedLength),
  };
}

function captureBufferCommand(term: Terminal): string {
  const buffer = term.buffer.active;
  const cursorRow = buffer.baseY + buffer.cursorY;

  // Walk up through wrapped lines to find the start of the logical row.
  let start = cursorRow;
  while (start > 0) {
    const line = buffer.getLine(start);
    if (line?.isWrapped) start -= 1;
    else break;
  }

  let text = "";
  for (let row = start; row <= cursorRow; row += 1) {
    const line = buffer.getLine(row);
    if (!line) continue;
    if (row === cursorRow) {
      const segment = line.translateToString(false).slice(0, buffer.cursorX);
      text += segment;
    } else {
      text += line.translateToString(false);
    }
  }

  const trimmed = text.replace(/\s+$/, "");

  // Heuristic prompt removal: take the tail after the last common shell
  // prompt terminator. Covers bash/zsh ("$ "/"# "), fish/tcsh ("% "),
  // PowerShell ("> "). If no terminator is found, return the whole line.
  const markers = ["$ ", "# ", "> ", "% "];
  let best = -1;
  for (const marker of markers) {
    const idx = trimmed.lastIndexOf(marker);
    if (idx > best) best = idx + marker.length;
  }

  const command = best >= 0 ? trimmed.slice(best) : trimmed;
  return command.trim();
}

function computeInlineGhost(
  term: Terminal | null,
  panel: HTMLDivElement | null,
  container: HTMLDivElement | null,
  enabled: boolean,
  pending: string,
  suggestion: string | null,
  invalidated: boolean,
): { left: number; top: number; maxWidth: number; height: number; text: string } | null {
  if (!enabled || !term || !panel || !container) return null;
  if (invalidated || !pending || !suggestion) return null;
  if (!suggestion.startsWith(pending) || suggestion.length <= pending.length) return null;
  if (term.buffer.active.type === "alternate") return null;

  const screen = container.querySelector<HTMLElement>(".xterm-screen");
  if (!screen) return null;

  const screenRect = screen.getBoundingClientRect();
  const panelRect = panel.getBoundingClientRect();
  if (screenRect.width === 0 || screenRect.height === 0 || term.cols === 0 || term.rows === 0) {
    return null;
  }

  // Only render when the cursor row is actually on screen (user hasn't scrolled away).
  const cursorX = term.buffer.active.cursorX;
  const cursorY = term.buffer.active.cursorY;
  if (cursorY < 0 || cursorY >= term.rows) return null;

  const cellWidth = screenRect.width / term.cols;
  const cellHeight = screenRect.height / term.rows;
  const baseLeft = screenRect.left - panelRect.left;
  const baseTop = screenRect.top - panelRect.top;

  const left = baseLeft + cursorX * cellWidth;
  const top = baseTop + cursorY * cellHeight;
  const maxWidth = Math.max(0, (term.cols - cursorX) * cellWidth);
  if (maxWidth <= 0) return null;

  const text = suggestion.slice(pending.length);
  return { left, top, maxWidth, height: cellHeight, text };
}

function getVisibleSearchHighlights(
  term: Terminal | null,
  panel: HTMLDivElement | null,
  container: HTMLDivElement | null,
  matches: SearchMatch[],
  activeIndex: number,
) {
  if (!term || !panel || !container || matches.length === 0) return [];

  const screen = container.querySelector<HTMLElement>(".xterm-screen");
  if (!screen) return [];

  const screenRect = screen.getBoundingClientRect();
  const panelRect = panel.getBoundingClientRect();
  if (screenRect.width === 0 || screenRect.height === 0 || term.cols === 0 || term.rows === 0) {
    return [];
  }

  const cellWidth = screenRect.width / term.cols;
  const cellHeight = screenRect.height / term.rows;
  const viewportTop = term.buffer.active.viewportY;
  const viewportBottom = viewportTop + term.rows - 1;
  const baseLeft = screenRect.left - panelRect.left;
  const baseTop = screenRect.top - panelRect.top;

  return matches
    .map((match, index) => ({ ...match, index }))
    .filter((match) => match.row >= viewportTop && match.row <= viewportBottom)
    .map((match) => ({
      row: match.row,
      col: match.col,
      active: match.index === activeIndex,
      left: baseLeft + match.col * cellWidth,
      top: baseTop + (match.row - viewportTop) * cellHeight,
      width: Math.max(cellWidth, match.length * cellWidth),
      height: cellHeight,
    }));
}

function getVisibleKeywordHighlights(
  term: Terminal | null,
  panel: HTMLDivElement | null,
  container: HTMLDivElement | null,
  mode: TerminalSyntaxMode,
) {
  if (mode !== "keywords" || !term || !panel || !container) return [];
  const matches = collectKeywordMatches(term);
  if (matches.length === 0) return [];

  const screen = container.querySelector<HTMLElement>(".xterm-screen");
  if (!screen) return [];

  const screenRect = screen.getBoundingClientRect();
  const panelRect = panel.getBoundingClientRect();
  if (screenRect.width === 0 || screenRect.height === 0 || term.cols === 0 || term.rows === 0) {
    return [];
  }

  const cellWidth = screenRect.width / term.cols;
  const cellHeight = screenRect.height / term.rows;
  const viewportTop = term.buffer.active.viewportY;
  const viewportBottom = viewportTop + term.rows - 1;
  const baseLeft = screenRect.left - panelRect.left;
  const baseTop = screenRect.top - panelRect.top;

  return matches
    .filter((match) => match.row >= viewportTop && match.row <= viewportBottom)
    .map((match) => ({
      ...match,
      left: baseLeft + match.col * cellWidth,
      top: baseTop + (match.row - viewportTop) * cellHeight,
      width: Math.max(cellWidth, match.length * cellWidth),
      height: cellHeight,
    }));
}

function collectKeywordMatches(term: Terminal): KeywordHighlight[] {
  const rules: Array<{ kind: KeywordHighlight["kind"]; pattern: RegExp }> = [
    { kind: "error", pattern: /\b(error|fail(?:ed|ure)?|denied|panic|fatal)\b/gi },
    { kind: "warning", pattern: /\b(warn(?:ing)?|caution)\b/gi },
    { kind: "success", pattern: /\b(success|ok|done|passed)\b/gi },
  ];
  const buffer = term.buffer.active;
  const matches: KeywordHighlight[] = [];

  for (let row = 0; row < buffer.length; row++) {
    const line = buffer.getLine(row);
    if (!line) continue;

    const { text, stringIndexToCell } = lineToSearchText(line);
    for (const rule of rules) {
      for (const match of text.matchAll(rule.pattern)) {
        if (typeof match.index !== "number" || !match[0]) continue;
        const startCell = stringIndexToCell[match.index];
        const lastCell = stringIndexToCell[match.index + match[0].length - 1];
        if (typeof startCell !== "number" || typeof lastCell !== "number") continue;
        const lastWidth = line.getCell(lastCell)?.getWidth() || 1;
        matches.push({
          row,
          col: startCell,
          length: Math.max(1, lastCell + lastWidth - startCell),
          kind: rule.kind,
        });
      }
    }
  }

  return matches;
}

function firstVisibleMatchIndex(
  term: Terminal,
  matches: SearchMatch[],
  direction: "next" | "previous",
): number {
  const viewportTop = term.buffer.active.viewportY;
  const viewportBottom = viewportTop + term.rows - 1;

  if (direction === "next") {
    const visible = matches.findIndex((match) => match.row >= viewportTop);
    return visible === -1 ? 0 : visible;
  }

  for (let i = matches.length - 1; i >= 0; i--) {
    if (matches[i].row <= viewportBottom) return i;
  }
  return matches.length - 1;
}

function normalizePasteText(text: string): string {
  return text.replace(/\r?\n/g, "\r");
}

// When the running app has enabled DEC bracketed paste (CSI ?2004h), wrap the
// payload so the app can distinguish a paste from typed input. The LFs inside
// the envelope are preserved on purpose: modern TUIs (Claude Code, ipython,
// nano, lazygit, ...) read \n as "newline inside the paste" and \r as "submit",
// and on Windows ConPTY there is no termios ICRNL to translate \r→\n the way
// Linux PTYs do. Without this wrapping a 9-line paste arrives as 9 separate
// Enter presses on Windows.
function formatPasteForTerminal(term: Terminal | null, text: string): string {
  if (term?.modes.bracketedPasteMode) {
    return `\x1b[200~${text.replace(/\r\n/g, "\n")}\x1b[201~`;
  }
  return normalizePasteText(text);
}

function downloadTextFile(filename: string, text: string, type: string): void {
  const blob = new Blob([text], { type });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}

function timestampFilePart(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

function safeFilePart(value: string): string {
  return value.trim().replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "") || "terminal";
}

function terminalProfileSignature(profile: TerminalProfile): string {
  return JSON.stringify(profile);
}

function shouldUseTerminalWebgl(): boolean {
  // Tauri uses WKWebView on macOS. On Intel/older macOS builds the WebGL
  // renderer can flash, lose context, or leave the terminal blank, while
  // xterm's default renderer stays stable for PTY/SSH output.
  return !(isTauriRuntime() && getAppPlatform() === "macos");
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

function parseOsc7(data: string): string | null {
  // OSC 7 payload looks like `file://hostname/path/with%20spaces`.
  const match = data.match(/^file:\/\/[^/]*(\/.*)$/);
  if (!match) return null;
  try {
    return decodeURIComponent(match[1]);
  } catch {
    return match[1];
  }
}

function parseOsc52ClipboardText(data: string): string | null {
  const separator = data.indexOf(";");
  if (separator < 0) return null;

  const targets = data.slice(0, separator);
  if (targets && !targets.includes("c") && !targets.includes("s")) return null;

  const encoded = data.slice(separator + 1).replace(/\s/g, "");
  if (!encoded || encoded === "?") return encoded === "" ? "" : null;
  if (encoded.length > Math.ceil((OSC52_MAX_DECODED_BYTES * 4) / 3) + 4) return null;

  try {
    const binary = atob(encoded);
    if (binary.length > OSC52_MAX_DECODED_BYTES) return null;
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return new TextDecoder().decode(bytes);
  } catch {
    return null;
  }
}

function encodeBinaryStringBase64(str: string): string {
  let binary = "";
  for (let i = 0; i < str.length; i++) {
    binary += String.fromCharCode(str.charCodeAt(i) & 0xff);
  }
  return btoa(binary);
}

function formatZmodemBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}


// AI inline `??` rendering: stream LLM tokens directly into the terminal as
// gray-styled ANSI text. The rendering is purely visual (xterm.write); it
// never reaches the underlying PTY, so a real `cat`/`grep`/`vim` can run on
// the next prompt without any ghost characters left behind. Each request
// uses a fresh `inline-qq:<request_id>` event channel so concurrent calls
// from different tabs do not cross-contaminate.
async function streamInlineAi(term: Terminal, question: string): Promise<void> {
  const { invoke } = await import("@tauri-apps/api/core");
  const requestId = `ai-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const event = `inline-qq:${requestId}`;

  // ANSI: dim gray foreground, bold prefix.
  const PREFIX = "\\x1b[38;5;244m\\x1b[1m[AI]\\x1b[0m\\x1b[38;5;244m ";
  const SUFFIX = "\\x1b[0m";

  // Header line so the user sees the question echoed back.
  term.write(`\\r\\n\\x1b[38;5;244m?? ${question}\\x1b[0m\\r\\n`);
  term.write(PREFIX);

  let unlisten: UnlistenFn | null = null;
  try {
    unlisten = await listen<{ kind: string; content?: string; message?: string }>(event, (e) => {
      const payload = e.payload;
      if (payload.kind === "token" && payload.content) {
        term.write(payload.content.replace(/\\n/g, "\\r\\n" + PREFIX));
      } else if (payload.kind === "error") {
        if (isVaultLockedError(payload.message ?? "")) {
          window.dispatchEvent(
            new CustomEvent(VAULT_LOCKED_EVENT, {
              detail: {
                reason:
                  "This AI provider's API key is in the credential vault — unlock it to continue.",
              },
            }),
          );
        }
        term.write(`${SUFFIX}\\r\\n\\x1b[31m[AI error] ${payload.message ?? "unknown"}${SUFFIX}\\r\\n`);
      } else if (payload.kind === "end") {
        term.write(`${SUFFIX}\\r\\n`);
      }
    });
    await invoke("inline_qq_stream", { requestId, question });
  } catch (e) {
    if (isVaultLockedError(e)) {
      window.dispatchEvent(
        new CustomEvent(VAULT_LOCKED_EVENT, {
          detail: {
            reason:
              "This AI provider's API key is in the credential vault — unlock it to continue.",
          },
        }),
      );
    }
    term.write(`${SUFFIX}\\r\\n\\x1b[31m[AI error] ${String(e)}${SUFFIX}\\r\\n`);
  } finally {
    if (unlisten) unlisten();
  }
}
