import {
  GitBranch,
  Inbox,
  KeyRound,
  MessageSquare,
  Network,
  Server,
  Shield,
  FileText,
  Wrench,
} from "lucide-react";
import type { ReactNode } from "react";
import { useT } from "../../lib/i18n";
import type { AppCommand } from "../menubar/commands";

/**
 * Tools mode list. Every entry mirrors a main-menu Tools item and its
 * `data-testid` (`sidebar-tool-code-workspace` opens Workspaces mode with the
 * legacy Code Workspace surface so existing TC-064/065 navigation still works).
 */
export function ToolsPanel({ onCommand }: { onCommand?: (command: AppCommand) => void }) {
  const t = useT();
  const items: Array<{
    id: AppCommand;
    label: string;
    icon: ReactNode;
    testId: string;
  }> = [
    {
      id: "servers",
      label: t("servers.dialogTitle"),
      icon: <Server className="w-4 h-4 shrink-0" />,
      testId: "sidebar-tool-servers",
    },
    {
      id: "tunneling",
      label: t("menu.tunneling"),
      icon: <Network className="w-4 h-4 shrink-0" />,
      testId: "sidebar-tool-tunneling",
    },
    {
      id: "sockscap",
      label: t("menu.sockscap"),
      icon: <Shield className="w-4 h-4 shrink-0" />,
      testId: "sidebar-tool-sockscap",
    },
    {
      id: "git",
      label: t("menu.gitRepository"),
      icon: <GitBranch className="w-4 h-4 shrink-0" />,
      testId: "sidebar-tool-git",
    },
    {
      id: "code-workspace",
      label: t("menu.codeWorkspace"),
      icon: <FileText className="w-4 h-4 shrink-0" />,
      testId: "sidebar-tool-code-workspace",
    },
    {
      id: "mail-unified",
      label: t("tabs.mailUnified"),
      icon: <Inbox className="w-4 h-4 shrink-0" />,
      testId: "sidebar-tool-mail-unified",
    },
    {
      id: "lan-chat",
      label: t("tabs.lanChat"),
      icon: <MessageSquare className="w-4 h-4 shrink-0" />,
      testId: "sidebar-tool-lan-chat",
    },
    {
      id: "mfa",
      label: t("menu.mfa"),
      icon: <KeyRound className="w-4 h-4 shrink-0" />,
      testId: "sidebar-tool-mfa",
    },
    {
      id: "tools",
      label: t("menu.networkTools"),
      icon: <Wrench className="w-4 h-4 shrink-0" />,
      testId: "sidebar-tool-network-tools",
    },
  ];

  return (
    <div data-testid="sidebar-tools-panel" className="flex-1 flex flex-col min-h-0">
      <div
        className="h-7 flex items-center gap-1.5 px-2 border-b shrink-0 font-semibold text-[var(--taomni-text)]"
        style={{ borderColor: "var(--taomni-divider)", fontSize: "var(--taomni-ui-font-size)" }}
      >
        <Wrench className="w-3.5 h-3.5" />
        {t("sidebar.utilityToolsTitle")}
      </div>
      <div className="flex-1 overflow-y-auto p-1.5">
        {items.map((item) => (
          <button
            key={item.id}
            type="button"
            data-testid={item.testId}
            className="w-full flex items-center gap-2 px-2 py-1.5 rounded text-left text-[var(--taomni-text)] hover:bg-[var(--taomni-hover)]"
            style={{ fontSize: "var(--taomni-ui-font-size)" }}
            onClick={() => onCommand?.(item.id)}
          >
            <span className="text-[var(--taomni-text-muted)]">{item.icon}</span>
            <span className="truncate">{item.label}</span>
          </button>
        ))}
      </div>
    </div>
  );
}
