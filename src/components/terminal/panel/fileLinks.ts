import type { ILink, Terminal } from "@xterm/xterm";
import { openFile } from "../../../lib/openFile";
import { fileOpenWorkspaceForTab } from "../../../lib/fileOpenContext";
import { findFilePathLinks } from "../../../lib/filePathLinks";
import { effectiveFileType, sftpStat } from "../../../lib/sftp";
import { getLocale } from "../../../lib/i18n";
import { getAppPlatform } from "../../../lib/runtime";
import { normalizeLocalStartCwd } from "../../../lib/terminalCwd";
import { useAppStore } from "../../../stores/appStore";
import type { TerminalSessionLifecycleContext } from "./sessionContracts";

/** xterm provider lifetime follows its terminal, not the current visible tab. */
export function installTerminalFileLinks(term: Terminal, context: TerminalSessionLifecycleContext): { dispose: () => void } {
  return term.registerLinkProvider({
    provideLinks(y, callback) {
      const row = term.buffer.active.getLine(y - 1);
      if (!row) { callback(undefined); return; }
      const text = row.translateToString(true);
      // Map UTF-16 indices back to terminal columns (wide CJK and surrogate pairs).
      const cells: number[] = [];
      let stringOffset = 0;
      for (let column = 0; column < term.cols; column += 1) {
        const cell = row.getCell(column);
        if (!cell || cell.getWidth() === 0) continue;
        const chars = cell.getChars() || " ";
        for (let index = 0; index < chars.length; index += 1) cells[stringOffset++] = column + 1;
      }
      const cwd = context.latestCwdRef.current;
      const links: ILink[] = findFilePathLinks(text, cwd).map((link) => ({
        text: link.text,
        range: { start: { x: cells[link.start] ?? link.start + 1, y }, end: { x: cells[link.end - 1] ?? link.end, y } },
        activate: (event) => {
          if (!(context.isMac ? event.metaKey : event.ctrlKey)) return;
          event.preventDefault();
          if (!context.isLocalRef.current) {
            context.setStatusMessage(getLocale().startsWith("zh") ? "SSH 文件路径：请先通过 SFTP 下载到本地后打开。" : "SSH file path: download it through SFTP before opening locally.");
            return;
          }
          const path = normalizeLocalStartCwd(link.path, getAppPlatform());
          if (!path) {
            context.setStatusMessage(getLocale().startsWith("zh") ? "此路径无法映射到本地文件系统。" : "This path cannot be mapped to the local filesystem.");
            return;
          }
          void (async () => {
            if (effectiveFileType(await sftpStat("", path, "local")) === "dir") return;
            const workspaceId = fileOpenWorkspaceForTab(context.tabId);
            const opened = await openFile({ path }, { context: "terminal-link", workspaceId, line: link.line });
            // xterm may restore the terminal tab after the async link handler
            // completes. Re-assert the main viewer on later tasks as well as
            // the immediate activation performed by openFile, so a repeated
            // link click cannot leave an existing viewer hidden behind its
            // source terminal.
            if (opened && !workspaceId && useAppStore.getState().tabs.some((tab) => tab.id === opened && tab.type === "file-viewer")) {
              const activate = () => {
                const app = useAppStore.getState();
                app.setActiveSideTab("sessions");
                app.setActiveTab(opened);
              };
              activate();
              window.setTimeout(activate, 50);
              window.setTimeout(activate, 250);
            }
          })().catch((error) => context.setStatusMessage(error instanceof Error ? error.message : String(error)));
        },
      }));
      callback(links.length ? links : undefined);
    },
  });
}
