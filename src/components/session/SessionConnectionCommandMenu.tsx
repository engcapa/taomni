import { Terminal as TerminalIcon } from "lucide-react";
import { writeText } from "../../lib/clipboard";
import type { SessionConfig } from "../../lib/ipc";
import type { TranslateFn } from "../../lib/i18n";
import {
  buildConnectionCommand,
  sessionSupportsConnectionCommand,
  type ConnectionCommandPlatform,
  type SshConnectionCommandPreset,
} from "../../lib/sessionConnectionCommand";
import type { MenuItem } from "../ContextMenu";

interface BuildSessionConnectionCommandMenuItemOptions {
  session: SessionConfig;
  allSessions: readonly SessionConfig[];
  t: TranslateFn;
  setStatusMessage: (message: string) => void;
}

export function buildSessionConnectionCommandMenuItem({
  session,
  allSessions,
  t,
  setStatusMessage,
}: BuildSessionConnectionCommandMenuItemOptions): MenuItem | null {
  if (!sessionSupportsConnectionCommand(session)) return null;

  const copyCommand = async (
    platform: ConnectionCommandPlatform,
    sshPreset?: SshConnectionCommandPreset,
  ) => {
    const result = buildConnectionCommand(session, { platform, sshPreset, allSessions });
    if (!result.ok) {
      setStatusMessage(t("sessionTree.connectionCommandUnavailable"));
      return;
    }

    try {
      await writeText(result.command);
      setStatusMessage(result.warnings.length > 0
        ? t("sessionTree.connectionCommandCopiedWithWarnings", {
          count: result.warnings.length,
          plural: result.warnings.length === 1 ? "" : "s",
        })
        : t("sessionTree.connectionCommandCopied"));
    } catch (error) {
      setStatusMessage(t("sessionTree.connectionCommandCopyFailed", {
        error: error instanceof Error ? error.message : String(error),
      }));
    }
  };

  const platformLabel = (platform: ConnectionCommandPlatform) =>
    platform === "posix"
      ? t("sessionTree.contextCopyCommandPosix")
      : t("sessionTree.contextCopyCommandPowerShell");

  const sshPresetItems = (platform: ConnectionCommandPlatform): MenuItem[] => [
    {
      label: t("sessionTree.contextCopyCommandBasic"),
      testId: `context-menu-item-copy-command-${platform}-basic`,
      onClick: () => void copyCommand(platform, "basic"),
    },
    {
      label: t("sessionTree.contextCopyCommandWithJump"),
      testId: `context-menu-item-copy-command-${platform}-jump`,
      onClick: () => void copyCommand(platform, "jump"),
    },
    {
      label: t("sessionTree.contextCopyCommandWithForwards"),
      testId: `context-menu-item-copy-command-${platform}-forwards`,
      onClick: () => void copyCommand(platform, "forwards"),
    },
    {
      label: t("sessionTree.contextCopyCommandFull"),
      testId: `context-menu-item-copy-command-${platform}-full`,
      onClick: () => void copyCommand(platform, "full"),
    },
  ];

  const platformItem = (platform: ConnectionCommandPlatform): MenuItem => {
    const testId = `context-menu-item-copy-command-${platform}`;
    if (session.session_type === "SSH") {
      return {
        label: platformLabel(platform),
        testId,
        children: sshPresetItems(platform),
      };
    }
    return {
      label: platformLabel(platform),
      testId,
      onClick: () => void copyCommand(platform),
    };
  };

  return {
    label: t("sessionTree.contextCopyConnectionCommand"),
    testId: "context-menu-item-copy-connection-command",
    icon: <TerminalIcon className="w-3 h-3" />,
    children: [
      platformItem("posix"),
      platformItem("powershell"),
    ],
  };
}
