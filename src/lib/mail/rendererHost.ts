import { useContextMenu } from "../../components/ContextMenu";
import { useConfirmDialog, useTextInputDialog } from "../../components/sidebar/ConfirmDialog";
import { FontPickerSelect } from "../../components/terminal/FontPickerPanel";
import { ThemePreviewSelect } from "../../components/theme/ThemePreviewSelect";
import { buildMailThemeOptions } from "../../components/theme/themePreviews";
import { useModalDraggableAndResizable } from "../../hooks/useModalDraggableAndResizable";
import { useAppTheme } from "../appTheme";
import { readClipboardImageFiles, readMultiFormat, readNativeClipboardImagePath, readText } from "../clipboard";
import { getCodeThemeDefinition, isCodeThemeId, terminalThemeFromCodeTheme } from "../codeThemes";
import { openTemporaryFile } from "../fileOpenTemp";
import {
  readFileBytes, selectFolderPath, selectSaveFilePath, selectUploadFile, temporaryFilePath,
  withVaultLockedNotice, writeStreamAbort, writeStreamAppend, writeStreamClose, writeStreamOpen,
} from "../ipc";
import { notifyDesktop } from "../notifications";
import { NATIVE_FILE_DROP_EVENT, droppedFilePaths, droppedFiles, isOsFileDrag, preventDefaultForOsFileDrag } from "../osFileDrop";
import { loadResizableLayout, saveResizableLayout } from "../resizableLayout";
import { isRecoveryStartup } from "../runtimeRecovery";
import {
  SAFE_TERMINAL_FONT_FALLBACKS, getPrimaryFontName, isMonospaceFont, makeTerminalFontFamily,
  resolveSelectedFontName, useSystemFonts, useTerminalFontOptions,
} from "../systemFonts";
import {
  DEFAULT_MAIL_TERMINAL_PROFILE, isCustomTerminalTheme, makeCustomTerminalTheme, resolveTerminalTheme, resolveTerminalThemeWithSystem,
} from "../terminalProfile";
import { getTerminalThemeDefinition, resolveThemeId } from "../themes";
import { openMailTabChat, pushMailNotification, rememberMailCertificate, sendMailContextToAi } from "./rendererServices";

const host = {
  contextMenu: { useContextMenu },
  dialogs: { useConfirmDialog, useTextInputDialog },
  fonts: { FontPickerSelect },
  themeSelect: { ThemePreviewSelect },
  themePreviews: { buildMailThemeOptions },
  modal: { useModalDraggableAndResizable },
  appTheme: { useAppTheme },
  clipboard: { readClipboardImageFiles, readMultiFormat, readNativeClipboardImagePath, readText },
  codeThemes: { getCodeThemeDefinition, isCodeThemeId, terminalThemeFromCodeTheme },
  fileOpen: { openTemporaryFile },
  files: {
    readFileBytes, selectFolderPath, selectSaveFilePath, selectUploadFile, temporaryFilePath,
    withVaultLockedNotice, writeStreamAbort, writeStreamAppend, writeStreamClose, writeStreamOpen,
  },
  notifications: { notifyDesktop },
  fileDrop: { NATIVE_FILE_DROP_EVENT, droppedFilePaths, droppedFiles, isOsFileDrag, preventDefaultForOsFileDrag },
  layout: { loadResizableLayout, saveResizableLayout },
  recovery: { isRecoveryStartup },
  systemFonts: {
    SAFE_TERMINAL_FONT_FALLBACKS, getPrimaryFontName, isMonospaceFont, makeTerminalFontFamily,
    resolveSelectedFontName, useSystemFonts, useTerminalFontOptions,
  },
  terminalTheme: {
    DEFAULT_MAIL_TERMINAL_PROFILE, isCustomTerminalTheme, makeCustomTerminalTheme, resolveTerminalTheme, resolveTerminalThemeWithSystem,
  },
  themes: { getTerminalThemeDefinition, resolveThemeId },
  mail: { openMailTabChat, pushMailNotification, rememberMailCertificate, sendMailContextToAi },
};

export type MailRendererHost = typeof host;

export function installMailRendererHost() {
  for (const service of Object.values(host)) Object.freeze(service);
  Object.defineProperty(globalThis, "__taomniMailRendererHost", { value: Object.freeze(host) });
}
