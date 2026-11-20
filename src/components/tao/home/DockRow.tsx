import { taoText as tr } from "../i18n";
import { ChevronUp, FolderOpen, History, MoreHorizontal, Plus, Terminal } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useT } from "../../../lib/i18n";
import { ThemedSelect } from "../../ThemedSelect";
import { openLocalShellAsAdministrator, type LocalDirectoryShortcut } from "../../../lib/ipc";
import { sftpLocalHome } from "../../../lib/sftp";
import { LocalDirectoriesPanel } from "../../welcome/LocalDirectoriesPanel";
import { localShellSelectionFromOption } from "../../welcome/sessionModel";
import { useChatStore } from "../../../stores/chatStore";
import type { WelcomePanelProps } from "../../welcome/types";
import { useWelcomeShells } from "../../welcome/useWelcomeShells";
import { HistoryPopover } from "./HistoryPopover";
import { TaoPopover, useTaoPopover } from "../ai-chat/Popover";
import type { TaoChatController, TaoThread } from "../ai-chat";

interface Props extends WelcomePanelProps {
  controller: TaoChatController; threads: TaoThread[]; demoMode: boolean;
  onDeleteThread?: (thread: TaoThread) => Promise<void>;
  historyLoading?: boolean; historyError?: string; onRefreshHistory?: () => void;
}

export function shouldShowWslEntry(status: "loading" | "ready" | "error" | "unsupported", distroCount: number): boolean {
  return status === "ready" && distroCount > 0;
}

export function DockRow(props: Props) {
  const { controller, threads, demoMode } = props;
  const t = useT();
  const [status, setStatus] = useState("");
  const [pending, setPending] = useState<string[]>([]);
  const pendingRef = useRef(new Set<string>());
  const history = useTaoPopover();
  const more = useTaoPopover();
  const shellMenu = useTaoPopover();
  useEffect(() => { if (props.active === false) { history.close(false); more.close(false); shellMenu.close(false); } }, [props.active]);
  const shells = useWelcomeShells({ setStatusMessage: setStatus, t, active: props.active !== false, suppressWslErrors: true });
  const hasWsl = shouldShowWslEntry(shells.wslStatus, shells.wslDistros.length);
  const canRestore = props.restore && ["available", "succeeded", "partial", "failed"].includes(props.restore.view.state);
  const startInDirectory = async (directory: LocalDirectoryShortcut) => {
    const key = directory.directoryId || `${directory.kind}:${directory.path}`;
    if (pendingRef.current.has(key)) return;
    pendingRef.current.add(key); setPending([...pendingRef.current]);
    try {
      const selected = shells.selectedShell;
      const outcome = await props.onStartLocalTerminal(localShellSelectionFromOption(selected, directory.path), selected?.id.startsWith("wsl:") ? undefined : directory.path);
      if (outcome?.status === "failed") setStatus(t("welcome.localDirectoryStartFailed", { path: directory.path, error: outcome.error ?? "" }));
      else if (outcome?.status === "started") history.close(false);
    } catch (error) { setStatus(String(error)); }
    finally { pendingRef.current.delete(key); setPending([...pendingRef.current]); }
  };
  const command = (name: string) => { window.dispatchEvent(new CustomEvent("taomni:command", { detail: name })); more.close(false); };
  const directories = demoMode ? shells.localDirectories.map((directory, index) => ({ ...directory, label: `${tr("目录")} ${index + 1}`, path: tr("已隐藏") })) : shells.localDirectories;
  const openHistoryThread = async (thread: TaoThread) => {
    if (thread.source === "legacy") {
      const chat = useChatStore.getState();
      if (!chat.threads.some((item) => item.id === thread.id)) await chat.loadThreads();
      const refreshed = useChatStore.getState();
      refreshed.setActiveThread(thread.id);
      await refreshed.loadMessages(thread.id);
      refreshed.setDrawerOpen(true);
      return;
    }
    controller.setActiveThread(thread.id);
  };
  return <>
    <div className="tao-home-dock-row" data-testid="tao-home-dock-row">
      <button ref={history.triggerRef} type="button" className="tao-home-dock-button history" data-testid="tao-home-history" aria-expanded={history.open} onClick={() => { if (!history.open && !props.historyLoading) props.onRefreshHistory?.(); history.setOpen(!history.open); }}><History size={14} />{tr("历史")}<ChevronUp size={12} /></button>
      <TaoPopover owner={history} className="tao-home-history-popup" label={tr("历史")}><HistoryPopover loading={props.historyLoading} error={props.historyError} onRefresh={props.onRefreshHistory} threads={threads} sessions={props.recentSessions ?? []} workspaces={props.recentWorkspaces ?? []} demoMode={demoMode} onSelectThread={(thread) => void openHistoryThread(thread)} onDeleteThread={props.onDeleteThread} onOpenSession={props.onOpenRecentSession} onOpenWorkspace={props.onOpenRecentWorkspace} onNewThread={() => controller.createThread()} onRestore={canRestore ? props.restore?.onStartRestore : undefined} onClose={() => history.close()} directories={<LocalDirectoriesPanel translate={t} directories={directories} pendingDirectoryIds={pending} loadStatus={shells.directoriesStatus} loadError={shells.directoriesError} onRetry={shells.reloadDirectories} onStartInDirectory={(directory) => {
        const actual = demoMode ? shells.localDirectories.find((item) => item.directoryId === directory.directoryId) : directory;
        if (actual) return startInDirectory(actual);
      }} />} /></TaoPopover>
      <span className="tao-home-dock-divider" />
      <button type="button" className="tao-home-dock-button" data-testid="tao-home-local-terminal" disabled={shells.shellStatus === "loading"} onClick={() => void props.onStartLocalTerminal(localShellSelectionFromOption(shells.selectedShell))}><Terminal size={14} />{tr("本地终端")}</button>
      <button ref={shellMenu.triggerRef} type="button" className="tao-home-dock-button" aria-label={tr("选择本地终端")} data-testid="tao-home-shell-menu" onClick={() => shellMenu.setOpen(!shellMenu.open)}><ChevronUp size={12} /></button>
      <TaoPopover owner={shellMenu} label={tr("本地终端选项")}><div className="tao-home-popup-items">
        <ThemedSelect label={tr("选择 Shell")} testId="tao-home-shell-options" value={shells.selectedShellId} onChange={shells.setSelectedShellId}
          options={shells.mergedShells.map((shell) => ({ value: shell.id, label: shell.name }))} />
        <button type="button" disabled={!shells.selectedShell?.canElevate} onClick={() => { shellMenu.close(); void openLocalShellAsAdministrator(shells.selectedShell?.id).catch((error) => setStatus(String(error))); }}>{tr("以管理员身份启动")}</button>
        <button type="button" data-testid="tao-home-open-home-folder" disabled={!props.onOpenLocalPath} onClick={() => { shellMenu.close(false); void sftpLocalHome().then((home) => { if (home) props.onOpenLocalPath?.(home, { embedFolder: true }); }).catch((error) => setStatus(String(error))); }}>{tr("打开 Home 目录")}</button>
      </div></TaoPopover>
      {hasWsl ? <button type="button" className="tao-home-dock-button" data-testid="tao-home-wsl" onClick={() => void props.onStartLocalTerminal({ id: "wsl.exe", name: `WSL: ${shells.wslDistros[0].name}`, args: ["-d", shells.wslDistros[0].name] })}>WSL</button> : null}
      <button type="button" className="tao-home-dock-button" data-testid="tao-home-new-session" onClick={props.onNewSession}><Plus size={14} />{tr("新会话")}</button>
      <button type="button" className="tao-home-dock-button" data-testid="tao-home-new-workspace" onClick={props.onOpenNewWorkspace}><FolderOpen size={14} />{tr("新工作区")}</button>
      <button ref={more.triggerRef} type="button" className="tao-home-dock-button" data-testid="tao-home-dock-more" aria-expanded={more.open} onClick={() => more.setOpen(!more.open)}><MoreHorizontal size={14} />{tr("更多")}</button>
      <TaoPopover owner={more} label={tr("更多启动选项")}><div className="tao-home-popup-items"><button type="button" data-testid="tao-home-dock-directory" onClick={() => command("file-explorer")}>{tr("本地目录")}</button><button type="button" data-testid="tao-home-dock-mail" onClick={() => command("mail-unified")}>{tr("邮件会话")}</button><button type="button" data-testid="tao-home-dock-session" onClick={() => { more.close(false); props.onNewSession(); }}>{tr("数据库 / VNC / RDP 会话")}</button><button type="button" data-testid="tao-home-dock-settings" onClick={() => { more.close(false); props.onOpenSettings?.(); }}>{tr("Tao 设置")}</button></div></TaoPopover>
    </div>
    {status ? <p className="tao-home-launch-status" role="status">{status}<button type="button" aria-label={tr("关闭启动提示")} onClick={() => setStatus("")}>×</button></p> : null}
  </>;
}
