import { useCallback } from "react";
import { promptAppDialog } from "../../../lib/appDialogs";
import { selectUploadFile, sendTerminalSignal } from "../../../lib/ipc";
import { loadTerminalDefaultProfile, saveTerminalDefaultProfile, type TerminalSyntaxMode } from "../../../lib/terminalProfile";
import { type ZmodemSendFile } from "../../../lib/zmodem";
import { collectTerminalBlockSelectionText } from "./buffer";
import { DEFAULT_FONT_SIZE, terminalCursorCell } from "./policy";
import { type TerminalBlockSelectionCell } from "./types";
import { useTerminalInteraction } from "./useTerminalInteraction";
import { useTerminalPanelState } from "./useTerminalPanelState";


export interface UseTerminalCommandsContext {
  tabId: string | undefined;
  tabTitle: string;
  panel: ReturnType<typeof useTerminalPanelState>;
  interaction: ReturnType<typeof useTerminalInteraction>;
  ssh: import("./types").SshConnectInfo | undefined;
}

export function useTerminalCommands(context: UseTerminalCommandsContext) {
  const { tabId, tabTitle, panel, interaction, ssh } = context;

  const renameTerminal = useCallback(async () => {
    if (!tabId) return;
    const nextTitle = await promptAppDialog({
      title: "Set terminal title",
      initialValue: tabTitle,
      allowEmpty: true,
    });
    if (!nextTitle?.trim()) return;
    panel.updateTabTitle(tabId, nextTitle.trim());
    interaction.focusTerminal();
  }, [interaction.focusTerminal, tabId, tabTitle, panel.updateTabTitle]);

  const resetOutput = useCallback(() => {
    panel.termRef.current?.reset();
    interaction.fitVisibleTerminal();
    interaction.focusTerminal();
  }, [interaction.fitVisibleTerminal, interaction.focusTerminal]);

  const clearScrollback = useCallback(() => {
    panel.termRef.current?.clear();
    interaction.focusTerminal();
  }, [interaction.focusTerminal]);

  const increaseFontSize = useCallback(() => {
    const nextSize = Math.min(panel.currentTerminalProfileRef.current.fontSize + 1, 32);
    panel.commitTerminalProfilePatch({ fontSize: nextSize });
  }, [panel.commitTerminalProfilePatch]);

  const decreaseFontSize = useCallback(() => {
    const nextSize = Math.max(panel.currentTerminalProfileRef.current.fontSize - 1, 8);
    panel.commitTerminalProfilePatch({ fontSize: nextSize });
  }, [panel.commitTerminalProfilePatch]);

  const resetFontSize = useCallback(() => {
    panel.commitTerminalProfilePatch({ fontSize: DEFAULT_FONT_SIZE });
  }, [panel.commitTerminalProfilePatch]);

  const setSyntaxModeAndFocus = useCallback((mode: TerminalSyntaxMode) => {
    panel.commitTerminalProfilePatch({ syntaxMode: mode });
    interaction.focusTerminal();
  }, [panel.commitTerminalProfilePatch, interaction.focusTerminal]);

  const saveCurrentAppearanceAsTerminalDefault = useCallback(() => {
    const currentDefault = loadTerminalDefaultProfile();
    const currentProfile = panel.currentTerminalProfileRef.current;
    saveTerminalDefaultProfile({
      ...currentDefault,
      theme: currentProfile.theme,
      fontFamily: currentProfile.fontFamily,
      fontSize: currentProfile.fontSize,
      fontLigatures: currentProfile.fontLigatures,
    });
    panel.setStatusMessage(panel.t("terminal.defaultAppearanceSaved"));
  }, [panel.setStatusMessage, panel.t]);

  const saveCurrentProfileAsTerminalDefault = useCallback(async () => {
    const confirmed = await panel.confirmTerminalDefaults({
      title: panel.t("terminal.saveAllDefaultConfirmTitle"),
      message: panel.t("terminal.saveAllDefaultConfirmMessage"),
      confirmLabel: panel.t("terminal.saveAllDefaultConfirmButton"),
    });
    if (!confirmed) return;
    saveTerminalDefaultProfile(panel.currentTerminalProfileRef.current);
    panel.setStatusMessage(panel.t("terminal.defaultProfileSaved"));
  }, [panel.confirmTerminalDefaults, panel.setStatusMessage, panel.t]);

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
    if (!panel.zmodemRef.current) {
      panel.setStatusMessage("Terminal not ready for ZMODEM");
      return;
    }
    if (panel.zmodemRef.current.isActive) {
      panel.setStatusMessage("A ZMODEM transfer is already in progress");
      return;
    }
    try {
      const files = await selectZmodemSendFiles();
      if (files.length === 0) return;
      panel.zmodemRef.current.queueSend(files);
      interaction.sendTerminalInput("rz\r");
      const names = files.map((f) => f.name).join(", ");
      panel.setStatusMessage(`Sending ${files.length === 1 ? files[0].name : `${files.length} files (${names})`} via ZMODEM…`);
    } catch (err) {
      panel.setStatusMessage(err instanceof Error ? err.message : "ZMODEM send failed");
    }
    interaction.focusTerminal();
  }, [interaction.focusTerminal, selectZmodemSendFiles, interaction.sendTerminalInput, panel.setStatusMessage]);

  const sendSpecialSignal = useCallback((signal: string, fallback?: string) => {
    const sid = panel.sessionIdRef.current;
    if (!sid) return;
    // PTY-backed SSH sessions receive terminal control bytes more reliably
    // than SSH channel requests on Windows OpenSSH/ConPTY. Some servers
    // acknowledge channel.signal(SIGINT) by closing the channel, which leaves
    // the interactive session unusable even though Ctrl-C is supported.
    if (ssh && fallback) {
      interaction.writeInput(fallback);
      interaction.appendEvent("signal", `Sent ${signal} control character`);
      panel.setStatusMessage(`Sent ${signal}`);
      interaction.focusTerminal();
      return;
    }
    sendTerminalSignal(sid, signal)
      .then(() => {
        interaction.appendEvent("signal", `Sent ${signal}`);
        panel.setStatusMessage(`Sent ${signal}`);
      })
      .catch((err) => {
        if (fallback) {
          interaction.writeInput(fallback);
          interaction.appendEvent("signal", `Sent ${signal} fallback control character`);
          panel.setStatusMessage(`Sent ${signal} fallback`);
        } else {
          interaction.appendEvent("error", `${signal} failed: ${String(err)}`);
          panel.setStatusMessage(err instanceof Error ? err.message : String(err));
        }
      });
    interaction.focusTerminal();
  }, [interaction.appendEvent, interaction.focusTerminal, panel.setStatusMessage, interaction.writeInput]);

  // Sends raw input to the terminal (and broadcasts when MultiExec is active)
  // WITHOUT running the pending-command tracker. Used by inline-suggestion
  // accept, which manages pending state explicitly.
  const sendUntrackedInput = useCallback((data: string) => {
    if (panel.readOnlyRef.current) return;
    if (panel.multiExecActiveRef.current) {
      panel.onInputBroadcastRef.current?.(data);
    }
    interaction.sendTerminalInput(data);
  }, [interaction.sendTerminalInput]);

  const acceptInlineSuggestion = useCallback((): boolean => {
    if (!interaction.suggestionsActiveRef.current) return false;
    const term = panel.termRef.current;
    if (!term || term.buffer.active.type === "alternate") return false;
    const suggestion = interaction.suggestionRef.current;
    const pending = interaction.pendingRef.current;
    if (!suggestion || !pending || suggestion.length <= pending.length) return false;
    if (interaction.invalidatedRef.current) return false;
    if (!interaction.ghostVisibleRef.current) return false;

    const suffix = suggestion.slice(pending.length);
    if (suffix.length === 0) return false;

    sendUntrackedInput(suffix);

    interaction.pendingRef.current = suggestion;
    interaction.invalidatedRef.current = false;
    interaction.suggestionRef.current = null;
    interaction.refreshSuggestion();
    interaction.bumpGhost();
    return true;
  }, [sendUntrackedInput, interaction.refreshSuggestion, interaction.bumpGhost]);

  const extendTerminalBlockSelectionByKeyboard = useCallback((key: string) => {
    const term = panel.termRef.current;
    if (!term) return false;
    const current = panel.blockSelectionRef.current;
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
    interaction.updateTerminalBlockSelection(next);
    interaction.showTerminalSelectionToolbar(collectTerminalBlockSelectionText(term, next));
    return true;
  }, [interaction.showTerminalSelectionToolbar, interaction.updateTerminalBlockSelection]);
  return {
    extendTerminalBlockSelectionByKeyboard,
    increaseFontSize,
    decreaseFontSize,
    resetFontSize,
    acceptInlineSuggestion,
    saveCurrentAppearanceAsTerminalDefault,
    saveCurrentProfileAsTerminalDefault,
    resetOutput,
    clearScrollback,
    renameTerminal,
    setSyntaxModeAndFocus,
    startZmodemSend,
    sendSpecialSignal,
    selectZmodemSendFiles,
  };
}
