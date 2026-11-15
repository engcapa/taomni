import { invoke } from "@tauri-apps/api/core";
import { writeText } from "../../../lib/clipboard";
import { loadTerminalDefaultProfile } from "../../../lib/terminalProfile";
import { openFile } from "../../../lib/openFile";
import { getLocale } from "../../../lib/i18n";
import { useAppStore } from "../../../stores/appStore";
import { useWorkspacePlatformStore } from "../../../stores/workspacePlatformStore";
import type { MenuItem } from "../../ContextMenu";

export interface GitFileTarget {
  repoRoot: string;
  path: string;
  repoName?: string;
}

export function gitFileAbsolutePath({ repoRoot, path }: GitFileTarget): string {
  const separator = repoRoot.includes("\\") ? "\\" : "/";
  const root = repoRoot.replace(/[\\/]+$/, "");
  return `${root}${separator}${path.replace(/^\/+/, "").split("/").join(separator)}`;
}

function fileDirectory(target: GitFileTarget): string {
  const parent = target.path.split("/").slice(0, -1).join("/");
  return parent ? gitFileAbsolutePath({ ...target, path: parent }) : target.repoRoot;
}

function openTerminal(directory: string) {
  const app = useAppStore.getState();
  if (app.activeSideTab === "workspaces") {
    const platform = useWorkspacePlatformStore.getState();
    platform.openLocalTerminalInWorkspace(platform.activeWorkspaceId, directory);
    return;
  }
  app.addTab({
    id: `local-${crypto.randomUUID()}`,
    type: "terminal",
    title: directory.split(/[\\/]/).filter(Boolean).at(-1) || "Local Terminal",
    terminalInitialCwd: directory,
    terminalProfile: loadTerminalDefaultProfile(),
    terminalTitleMode: "auto",
    terminalTitleOperation: "new",
    closable: true,
  });
}

/** Common worktree actions also work for deleted files in historical commits. */
export function gitFileMenuItems(
  targets: GitFileTarget[],
  contextTarget: GitFileTarget | undefined = targets[0],
): MenuItem[] {
  const disabled = targets.length === 0;
  const run = (action: () => unknown | Promise<unknown>, message: string) => {
    void Promise.resolve().then(action).then(() => {
      useAppStore.getState().setStatusMessage(message);
    }).catch((error: unknown) => {
      useAppStore.getState().setStatusMessage(error instanceof Error ? error.message : String(error));
    });
  };
  const directory = contextTarget ? fileDirectory(contextTarget) : "";
  return [
    {
      label: getLocale().startsWith("zh") ? "预览此文件" : "Preview file",
      testId: "git-file-preview",
      disabled: !contextTarget,
      onClick: () => run(() => openFile({ path: gitFileAbsolutePath(contextTarget!) }, {
        context: "git", mode: "taomni", workspaceId: useAppStore.getState().activeSideTab === "workspaces"
          ? useWorkspacePlatformStore.getState().activeWorkspaceId : undefined,
      }), "Opened file preview"),
    },
    {
      label: targets.length > 1 ? `Copy paths (${targets.length})` : "Copy Path",
      testId: "git-file-copy-path",
      disabled,
      onClick: () => run(() => writeText(targets.map(gitFileAbsolutePath).join("\n")), "Copied path"),
    },
    {
      label: "Copy Relative Path",
      testId: "git-file-copy-relative-path",
      disabled,
      onClick: () => run(() => writeText(targets.map((target) => (
        targets.length > 1 && target.repoName ? `${target.repoName}: ${target.path}` : target.path
      )).join("\n")), "Copied relative path"),
    },
    {
      label: "Reveal in Explorer",
      testId: "git-file-reveal",
      disabled: !contextTarget,
      onClick: () => run(() => invoke("sftp_open_path", { path: directory }), `Opened ${directory}`),
    },
    {
      label: "Open in Terminal",
      testId: "git-file-open-terminal",
      disabled: !contextTarget,
      onClick: () => run(() => openTerminal(directory), `Opened terminal in ${directory}`),
    },
  ];
}
