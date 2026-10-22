import { useCallback, useEffect, type MouseEvent as ReactMouseEvent } from "react";
import { Terminal } from "@xterm/xterm";
import { isCustomTerminalTheme, resolveTerminalTheme, type TerminalProfile, type TerminalSyntaxMode } from "../../../lib/terminalProfile";
import { resolveThemeId } from "../../../lib/themes";
import { buildTerminalThemeOptions } from "../../theme/themePreviews";
import { TerminalAppearanceMenuPanel } from "../TerminalAppearanceMenuPanel";
import { type ZmodemState } from "../../../lib/zmodem";
import { useChatStore } from "../../../stores/chatStore";
import { type MenuItem } from "../../ContextMenu";
import { type TerminalGitState } from "./types";
import { getLastBufferLines } from "./buffer";


export interface UseTerminalContextMenuContext {
  getActiveTerminalSelectionText: () => string;
  isMac: boolean;
  themeName: string;
  t: import("../../../lib/i18n").TranslateFn;
  copySelection: () => Promise<void>;
  copyAll: () => void;
  copyFormattedSelection: () => Promise<void>;
  pasteFromClipboard: () => Promise<void>;
  effectiveReadOnly: boolean;
  openSearch: () => void;
  gitToggle: { cwd: string | null; onOpen: () => void; } | undefined;
  gitState: TerminalGitState;
  increaseFontSize: () => void;
  decreaseFontSize: () => void;
  resetFontSize: () => void;
  fontFamily: string;
  fontSize: number;
  commitTerminalProfilePatch: (patch: Partial<TerminalProfile>) => void;
  saveCurrentAppearanceAsTerminalDefault: () => void;
  saveCurrentProfileAsTerminalDefault: () => Promise<void>;
  resetOutput: () => void;
  clearScrollback: () => void;
  renameTerminal: () => Promise<void>;
  tabId: string | undefined;
  showScrollbar: boolean;
  fullscreen: boolean;
  setFullscreen: import("react").Dispatch<import("react").SetStateAction<boolean>>;
  readOnly: boolean;
  syntaxMode: TerminalSyntaxMode;
  setSyntaxModeAndFocus: (mode: TerminalSyntaxMode) => void;
  executeMacro: () => void;
  lastMacroRef: import("react").RefObject<string>;
  macroRecording: boolean;
  toggleMacroRecording: () => void;
  loggingActive: boolean;
  toggleOutputRecording: () => void;
  saveBufferToFile: () => void;
  startZmodemSend: () => Promise<void>;
  zmodemState: ZmodemState;
  setSettingsDialogOpen: import("react").Dispatch<import("react").SetStateAction<boolean>>;
  sendSpecialSignal: (signal: string, fallback?: string) => void;
  setEventLogOpen: import("react").Dispatch<import("react").SetStateAction<boolean>>;
  termRef: import("react").RefObject<Terminal | null>;
  setStatusMessage: (message: string) => void;
  fontLigatures: boolean;
  contextMenu: { show: (e: React.MouseEvent, items: MenuItem[]) => void; showAt: (x: number, y: number, items: MenuItem[], menuOptions?: import("../../ContextMenu").ContextMenuAppearance) => void; refreshItems: (items: MenuItem[]) => void; close: (reason?: import("../../ContextMenu").ContextMenuCloseReason) => void; render: import("react").JSX.Element | null; isOpen: boolean; };
  rightClickBehavior: "menu" | "paste" | "copy-or-paste";
}

export function useTerminalContextMenu(context: UseTerminalContextMenuContext) {
  const {
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
  } = context;

  const buildContextMenu = useCallback((): MenuItem[] => {
    const hasSelection = !!getActiveTerminalSelectionText();
    const copyShortcut = isMac ? "Cmd+C" : "Ctrl+Shift+C";
    const pasteShortcut = isMac ? "Cmd+V" : "Ctrl+Shift+V / Shift+Insert";
    const customTheme = isCustomTerminalTheme(themeName) ? resolveTerminalTheme(themeName) : null;
    const themeMenuValue = customTheme ? themeName : resolveThemeId(themeName);
    const themeOptions = buildTerminalThemeOptions({
      includeSystem: true,
      systemLabel: t("terminalAppearance.themeSystemName"),
      customValue: customTheme ? themeName : undefined,
      customTheme,
      customLabel: "Custom colors",
      darkGroup: "Dark",
      lightGroup: "Light",
    }).map((option) => ({
      ...option,
      testId: `terminal-context-theme-option-${option.value.replace(/[^a-zA-Z0-9_-]+/g, "-")}`,
    }));

    return [
      { label: "Copy", shortcut: copyShortcut, onClick: () => void copySelection(), disabled: !hasSelection },
      { label: "Copy All", onClick: copyAll },
      { label: "Copy formatted text (HTML/RTF)", onClick: () => void copyFormattedSelection(), disabled: !hasSelection },
      { label: "Paste", shortcut: pasteShortcut, onClick: () => void pasteFromClipboard(), disabled: effectiveReadOnly },
      { label: "Find", shortcut: "Ctrl+Shift+F", onClick: openSearch },
      ...(gitToggle
        ? [
          { label: "", separator: true },
          {
            label: gitState.kind === "none" ? "Initialize Git Repository..." : "Open Git Panel",
            shortcut: isMac ? "Cmd+Shift+G" : "Ctrl+Shift+G",
            onClick: gitToggle.onOpen,
            disabled: !gitToggle.cwd,
          },
        ]
        : []),
      { label: "", separator: true },
      { label: "Zoom in", shortcut: "Ctrl++ / Ctrl+WheelUp", onClick: increaseFontSize },
      { label: "Zoom out", shortcut: "Ctrl+- / Ctrl+WheelDown", onClick: decreaseFontSize },
      { label: "Reset zoom", shortcut: "Ctrl+0", onClick: resetFontSize },
      {
        label: "Appearance",
        testId: "context-menu-item-appearance",
        customPanel: (
          <TerminalAppearanceMenuPanel
            themeValue={themeMenuValue}
            themeOptions={themeOptions}
            fontFamily={fontFamily}
            fontSize={fontSize}
            fontSelectTestId="terminal-context-font-select"
            fontSizeTestId="terminal-context-font-size"
            onChangeTheme={(nextTheme) => commitTerminalProfilePatch({ theme: nextTheme })}
            onChangeFontFamily={(nextFontFamily) => commitTerminalProfilePatch({ fontFamily: nextFontFamily })}
            onChangeFontSize={(nextFontSize) => commitTerminalProfilePatch({ fontSize: nextFontSize })}
          />
        ),
      },
      {
        label: t("terminal.contextSetAppearanceDefault"),
        testId: "terminal-context-set-local-default-theme",
        onClick: saveCurrentAppearanceAsTerminalDefault,
      },
      {
        label: t("terminal.contextSetProfileDefault"),
        testId: "terminal-context-set-local-default-profile",
        onClick: () => {
          void saveCurrentProfileAsTerminalDefault();
        },
      },
      {
        label: "Terminal display",
        testId: "context-menu-item-terminal-display",
        children: [
          { label: "Reset terminal output", onClick: resetOutput },
          { label: "Clear terminal scrollback", onClick: clearScrollback },
          { label: "Set terminal title", onClick: renameTerminal, disabled: !tabId },
          {
            label: "Toggle terminal scrollbar",
            testId: "context-menu-item-toggle-terminal-scrollbar",
            checked: showScrollbar,
            onClick: () => commitTerminalProfilePatch({ showScrollbar: !showScrollbar }),
          },
          {
            label: "Fullscreen terminal",
            testId: "context-menu-item-fullscreen-terminal",
            shortcut: "F11",
            checked: fullscreen,
            onClick: () => setFullscreen((v) => !v),
          },
          {
            label: "Read-only terminal",
            testId: "context-menu-item-read-only-terminal",
            checked: readOnly,
            onClick: () => commitTerminalProfilePatch({ readOnly: !readOnly }),
          },
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
      {
        label: t("terminal.contextChangeSettings"),
        testId: "terminal-context-change-settings",
        onClick: () => setSettingsDialogOpen(true),
      },
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
      { label: "Event Log", testId: "context-menu-item-event-log", onClick: () => setEventLogOpen(true) },
      { label: "", separator: true },
      {
        label: "AI: 解释最近的终端输出",
        onClick: () => {
          const term = termRef.current;
          if (!term) return;
          // Pull the last 50 lines from the buffer; if there's a selection,
          // prefer that. Both paths route to a fresh AI thread via
          // explainSelection (already redacts via chat::redact server-side).
          const selected = getActiveTerminalSelectionText();
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
    commitTerminalProfilePatch,
    decreaseFontSize,
    executeMacro,
    fontFamily,
    fontLigatures,
    fontSize,
    fullscreen,
    getActiveTerminalSelectionText,
    gitState.kind,
    gitToggle,
    increaseFontSize,
    isMac,
    openSearch,
    pasteFromClipboard,
    effectiveReadOnly,
    readOnly,
    renameTerminal,
    resetFontSize,
    resetOutput,
    saveBufferToFile,
    saveCurrentAppearanceAsTerminalDefault,
    saveCurrentProfileAsTerminalDefault,
    showScrollbar,
    setStatusMessage,
    syntaxMode,
    setSyntaxModeAndFocus,
    t,
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

  useEffect(() => {
    if (!contextMenu.isOpen) return;
    contextMenu.refreshItems(buildContextMenu());
  }, [buildContextMenu, contextMenu.isOpen, contextMenu.refreshItems]);

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
      if (getActiveTerminalSelectionText()) {
        void copySelection();
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
    getActiveTerminalSelectionText,
    pasteFromClipboard,
    rightClickBehavior,
  ]);
  return { handleTerminalContextMenu };
}
