import { ChevronUp, FolderOpen, History, Mail, MoreHorizontal, Plus, Terminal, Workflow } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useT } from "../../../lib/i18n";
import type { SessionConfig } from "../../../lib/ipc";
import type { RecentWorkspace } from "../../../types";
import { useWelcomeShells } from "../../welcome/useWelcomeShells";
import { HistoryPopover } from "./HistoryPopover";
import type { TaoChatController, TaoThread } from "../ai-chat";

function noopStatusMessage(_message: string): void {
  // Tao Home keeps shell detection side-effect free; status belongs to the host.
}

export function DockRow({ controller, threads, sessions, workspaces, demoMode, onStartLocalTerminal, onNewSession, onOpenNewWorkspace, onOpenRecentSession, onOpenRecentWorkspace, onRestore, onOpenSettings }: { controller: TaoChatController; threads: TaoThread[]; sessions: SessionConfig[]; workspaces: RecentWorkspace[]; demoMode: boolean; onStartLocalTerminal: (shell?: { id: string; name: string; args?: string[] }) => void; onNewSession: () => void; onOpenNewWorkspace?: () => void; onOpenRecentSession?: (session: SessionConfig) => void; onOpenRecentWorkspace?: (workspace: RecentWorkspace) => void; onRestore?: () => void; onOpenSettings?: () => void }) {
  const t = useT();
  const [historyOpen, setHistoryOpen] = useState(false);
  const [moreOpen, setMoreOpen] = useState(false);
  const historyRef = useRef<HTMLDivElement>(null);
  const { selectedShell, shellStatus, wslDistros, wslStatus } = useWelcomeShells({ setStatusMessage: noopStatusMessage, t, active: true });
  const hasWsl = wslStatus === "ready" && wslDistros.length > 0;
  useEffect(() => {
    if (historyOpen) historyRef.current?.querySelector<HTMLElement>("[data-testid='tao-home-history-popover']")?.focus();
  }, [historyOpen]);
  return <div className="tao-home-dock-row" data-testid="tao-home-dock-row"><div ref={historyRef} className="tao-home-dock-history-wrap"><button type="button" className="tao-home-dock-button history" data-testid="tao-home-history" onClick={() => setHistoryOpen(!historyOpen)}><History size={14} />历史<ChevronUp size={12} /></button>{historyOpen ? <HistoryPopover threads={threads} sessions={sessions} workspaces={workspaces} demoMode={demoMode} onSelectThread={(thread) => controller.setActiveThread(thread.id)} onOpenSession={onOpenRecentSession} onOpenWorkspace={onOpenRecentWorkspace} onNewThread={() => controller.createThread()} onRestore={onRestore} onClose={() => setHistoryOpen(false)} /> : null}</div><span className="tao-home-dock-divider" />{<button type="button" className="tao-home-dock-button" data-testid="tao-home-local-terminal" data-legacy-testid="welcome-open-local-terminal" disabled={shellStatus === "loading"} onClick={() => onStartLocalTerminal(selectedShell)}><Terminal size={14} />本地终端</button>}{hasWsl ? <button type="button" className="tao-home-dock-button" data-testid="tao-home-wsl" onClick={() => onStartLocalTerminal({ id: `wsl:${wslDistros[0].name}`, name: `WSL: ${wslDistros[0].name}`, args: ["-d", wslDistros[0].name] })}>WSL</button> : null}<button type="button" className="tao-home-dock-button" data-testid="tao-home-new-session" data-legacy-testid="welcome-new-session" onClick={onNewSession}><Plus size={14} />新会话</button><button type="button" className="tao-home-dock-button" data-testid="tao-home-new-workspace" data-legacy-testid="home-open-workspace" onClick={() => onOpenNewWorkspace?.()}><FolderOpen size={14} />新工作区</button><div className="tao-home-dock-more-wrap"><button type="button" className="tao-home-dock-button" data-testid="tao-home-dock-more" onClick={() => setMoreOpen(!moreOpen)}><MoreHorizontal size={14} />更多</button>{moreOpen ? <div className="tao-home-dock-more-menu"><button type="button" onClick={() => window.dispatchEvent(new CustomEvent("taomni:command", { detail: "mail-unified" }))}><Mail size={13} />邮件会话</button><button type="button" onClick={() => window.dispatchEvent(new CustomEvent("taomni:command", { detail: "database" }))}>数据库会话</button><button type="button" onClick={() => window.dispatchEvent(new CustomEvent("taomni:command", { detail: "tools" }))}><Workflow size={13} />网络工具</button><button type="button" onClick={onOpenSettings}>Tao 设置</button></div> : null}</div></div>;
}
