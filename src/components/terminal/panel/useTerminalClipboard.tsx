import { useCallback, useEffect, type DragEvent as ReactDragEvent } from "react";
import { Terminal } from "@xterm/xterm";
import {
  readFiles as clipboardReadFiles,
  parseFilePaths as clipboardParseFilePaths,
  readText as clipboardReadText,
  writeText as clipboardWriteText,
  writeMultiFormat as clipboardWriteMultiFormat,
} from "../../../lib/clipboard";
import { promptAppDialog } from "../../../lib/appDialogs";
import {
  NATIVE_FILE_DROP_EVENT,
  type NativeFileDropDetail,
  droppedFilePaths,
  formatDroppedPathsForShell,
  isOsFileDrag,
  shellQuoteStyleForTerminalDrop,
} from "../../../lib/osFileDrop";
import { type TerminalBlockSelection } from "./types";
import { formatPasteForTerminal, uniqueNonEmpty, terminalCanPromptForLocalPathUpload } from "./transfer";
import { escapeHtml } from "./policy";
import { getBufferText, collectTerminalBlockSelectionText } from "./buffer";


export interface UseTerminalClipboardContext {
  setStatusMessage: (message: string) => void;
  setSelectionToolbar: import("react").Dispatch<import("react").SetStateAction<{ rect: { top: number; left: number; right: number; bottom: number; }; text: string; } | null>>;
  containerRef: import("react").RefObject<HTMLDivElement | null>;
  blockSelectionRef: import("react").RefObject<TerminalBlockSelection | null>;
  termRef: import("react").RefObject<Terminal | null>;
  blockSelectionTextRef: import("react").RefObject<string>;
  setBlockSelection: import("react").Dispatch<import("react").SetStateAction<TerminalBlockSelection | null>>;
  focusTerminal: () => void;
  resolvePanelTheme: (name: string) => import("@xterm/xterm").ITheme;
  themeName: string;
  fontFamily: string;
  fontSize: number;
  readOnlyRef: import("react").RefObject<boolean>;
  multilinePasteConfirm: boolean;
  confirmPaste: (options: import("../../sidebar/ConfirmDialog").ConfirmDialogOptions) => Promise<boolean>;
  t: import("../../../lib/i18n").TranslateFn;
  writeBroadcastInput: (data: string) => void;
  isLocal: boolean;
  resolvedLocalShellId: string | null;
  localShell: { id: string; name: string; args?: string[]; } | undefined;
  appendEvent: (type: string, detail: string) => void;
  onUploadLocalPathsRef: import("react").RefObject<((request: import("./types").TerminalLocalPathUploadRequest) => Promise<void> | void) | undefined>;
  latestCwdRef: import("react").RefObject<string | null>;
  panelRef: import("react").RefObject<HTMLDivElement | null>;
}

export function useTerminalClipboard(context: UseTerminalClipboardContext) {
  const {
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
  } = context;

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

  const showTerminalSelectionToolbar = useCallback((text: string) => {
    if (!text || text.trim().length < 2) {
      setSelectionToolbar(null);
      return;
    }
    const container = containerRef.current;
    if (!container) return;
    const rect = container.getBoundingClientRect();
    setSelectionToolbar({
      text,
      rect: {
        top: rect.top + 24,
        left: rect.left + rect.width / 3,
        right: rect.right,
        bottom: rect.bottom,
      },
    });
  }, []);

  const updateTerminalBlockSelection = useCallback((next: TerminalBlockSelection | null) => {
    blockSelectionRef.current = next;
    const term = termRef.current;
    blockSelectionTextRef.current = next && term ? collectTerminalBlockSelectionText(term, next) : "";
    setBlockSelection(next);
    if (!next) {
      setSelectionToolbar(null);
    }
  }, []);

  const getActiveTerminalSelectionText = useCallback(() => {
    const term = termRef.current;
    if (!term) return "";
    const block = blockSelectionRef.current;
    if (block) {
      const text = blockSelectionTextRef.current || collectTerminalBlockSelectionText(term, block);
      if (text) return text;
    }
    return term.getSelection();
  }, []);

  const clearTerminalBlockSelection = useCallback(() => {
    updateTerminalBlockSelection(null);
  }, [updateTerminalBlockSelection]);

  const copySelection = useCallback(async () => {
    const term = termRef.current;
    if (!term) return;
    await writeClipboardText(getActiveTerminalSelectionText(), "Copied selection");
    focusTerminal();
  }, [focusTerminal, getActiveTerminalSelectionText, writeClipboardText]);

  const copyAll = useCallback(() => {
    const term = termRef.current;
    if (!term) return;
    void writeClipboardText(getBufferText(term), "Copied terminal buffer");
    focusTerminal();
  }, [focusTerminal, writeClipboardText]);

  const copyFormattedSelection = useCallback(async () => {
    const term = termRef.current;
    if (!term) return;
    const text = getActiveTerminalSelectionText();
    if (!text) {
      setStatusMessage("Nothing to copy");
      return;
    }

    const resolvedTheme = resolvePanelTheme(themeName);
    const html = `<pre style="margin:0;font-family:${escapeHtml(fontFamily)};font-size:${fontSize}px;background:${resolvedTheme.background ?? "#1d1f21"};color:${resolvedTheme.foreground ?? "#eaeaea"};white-space:pre-wrap;">${escapeHtml(text)}</pre>`;

    try {
      await clipboardWriteMultiFormat({ text, html });
      setStatusMessage("Copied formatted selection");
    } catch (err) {
      setStatusMessage(err instanceof Error ? err.message : "Formatted copy failed");
    } finally {
      focusTerminal();
    }
  }, [focusTerminal, fontFamily, fontSize, getActiveTerminalSelectionText, resolvePanelTheme, setStatusMessage, themeName, writeClipboardText]);

  const pasteTextIntoTerminal = useCallback(async (text: string): Promise<boolean> => {
    if (readOnlyRef.current) {
      setStatusMessage("Terminal is read-only");
      return false;
    }

    if (!text) return false;
    if (multilinePasteConfirm && /\r?\n/.test(text)) {
      const lineCount = text.split(/\r?\n/).length;
      const ok = await confirmPaste({
        title: t("terminal.multilinePasteTitle"),
        message: t("terminal.multilinePasteMessage", { count: lineCount }),
        confirmLabel: t("terminal.paste"),
      });
      if (!ok) return false;
    }
    writeBroadcastInput(formatPasteForTerminal(termRef.current, text));
    focusTerminal();
    return true;
  }, [confirmPaste, focusTerminal, multilinePasteConfirm, setStatusMessage, t, writeBroadcastInput]);

  const handleTerminalDragOver = useCallback((event: ReactDragEvent<HTMLDivElement>) => {
    if (!isOsFileDrag(event.dataTransfer)) return;
    event.preventDefault();
    if (readOnlyRef.current) {
      event.dataTransfer.dropEffect = "none";
      return;
    }
    event.dataTransfer.dropEffect = "copy";
  }, []);

  const insertFilePaths = useCallback((paths: string[]) => {
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

  const handleLocalFilePaths = useCallback(async (paths: string[]) => {
    const cleanPaths = uniqueNonEmpty(paths);
    if (cleanPaths.length === 0) return;
    if (readOnlyRef.current) {
      setStatusMessage("Terminal is read-only");
      focusTerminal();
      return;
    }

    const term = termRef.current;
    const upload = onUploadLocalPathsRef.current;
    const canOfferUpload =
      !isLocal &&
      !!upload &&
      terminalCanPromptForLocalPathUpload(term);
    if (!canOfferUpload) {
      insertFilePaths(cleanPaths);
      return;
    }

    const cwd = latestCwdRef.current;
    const confirmed = await confirmPaste({
      title: t("terminal.filePasteTitle"),
      message: t("terminal.filePasteMessage", {
        count: cleanPaths.length,
        cwd: cwd ?? t("terminal.filePasteUnknownCwd"),
      }),
      confirmLabel: t("terminal.filePasteUpload"),
      cancelLabel: t("terminal.filePastePaths"),
    });

    if (!confirmed) {
      insertFilePaths(cleanPaths);
      return;
    }

    try {
      await upload({ paths: cleanPaths, cwd });
      setStatusMessage(t("terminal.filePasteUploadQueued", { count: cleanPaths.length }));
      focusTerminal();
    } catch (err) {
      setStatusMessage(err instanceof Error ? err.message : "Upload failed");
      focusTerminal();
    }
  }, [confirmPaste, focusTerminal, insertFilePaths, isLocal, setStatusMessage, t]);

  const pasteFromClipboard = useCallback(async () => {
    if (readOnlyRef.current) {
      setStatusMessage("Terminal is read-only");
      return;
    }

    try {
      if (!isLocal && onUploadLocalPathsRef.current) {
        const paths = await clipboardReadFiles();
        if (paths.length > 0) {
          await handleLocalFilePaths(paths);
          return;
        }
      }
      const text =
        (await clipboardReadText()) ||
        (await promptAppDialog({
          title: "Paste text",
          initialValue: "",
          allowEmpty: true,
        })) ||
        "";
      if (!text) return;

      if (!isLocal && onUploadLocalPathsRef.current) {
        const textPaths = await clipboardParseFilePaths(text);
        if (textPaths.length > 0) {
          await handleLocalFilePaths(textPaths);
          return;
        }
      }

      await pasteTextIntoTerminal(text);
    } catch (err) {
      setStatusMessage(err instanceof Error ? err.message : "Clipboard paste failed");
    }
  }, [handleLocalFilePaths, isLocal, pasteTextIntoTerminal, setStatusMessage]);

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

    void handleLocalFilePaths(paths);
  }, [focusTerminal, handleLocalFilePaths, setStatusMessage]);

  useEffect(() => {
    const handleNativeFileDrop = (event: Event) => {
      const detail = (event as CustomEvent<NativeFileDropDetail>).detail;
      if (!detail?.paths?.length) return;

      const panel = panelRef.current;
      const target = document.elementFromPoint(detail.clientX, detail.clientY);
      if (!panel || !target || !panel.contains(target)) return;

      void handleLocalFilePaths(detail.paths);
    };

    window.addEventListener(NATIVE_FILE_DROP_EVENT, handleNativeFileDrop);
    return () => window.removeEventListener(NATIVE_FILE_DROP_EVENT, handleNativeFileDrop);
  }, [handleLocalFilePaths]);
  return { clearTerminalBlockSelection, updateTerminalBlockSelection, showTerminalSelectionToolbar, getActiveTerminalSelectionText, copySelection, pasteFromClipboard, copyAll, copyFormattedSelection, writeClipboardText, handleLocalFilePaths, pasteTextIntoTerminal, handleTerminalDragOver, handleTerminalDrop };
}
