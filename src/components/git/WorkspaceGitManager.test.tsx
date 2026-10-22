import "./tests/workspaceGitManager/harness";
import { cleanup } from "@testing-library/react";
import { afterEach, beforeEach, describe } from "vitest";
import { useAppStore } from "../../stores/appStore";
import { registerWorkspaceGitManagerBehavior2Cases } from "./tests/workspaceGitManager/behavior2.cases";
import { registerWorkspaceGitManagerEditing1Cases } from "./tests/workspaceGitManager/editing1.cases";
import { dialogMocks, gitMocks, snapshot, workspaceMocks } from "./tests/workspaceGitManager/harness";

describe("WorkspaceGitManager", () => {
  beforeEach(() => {
    window.localStorage.clear();
    window.localStorage.setItem("taomni.git.workspace.changes.tree", "flat");
    useAppStore.setState({ statusMessage: "Ready" });
    gitMocks.gitBlobPair.mockReset();
    gitMocks.gitBlobPair.mockResolvedValue({
      path: "src/App.tsx",
      oldPath: null,
      oldText: "old",
      newText: "new",
      oldExists: true,
      newExists: true,
      binary: false,
      image: false,
      oldImageB64: null,
      newImageB64: null,
      oversize: false,
      oldSize: 3,
      newSize: 3,
    });
    gitMocks.gitCommit.mockReset();
    gitMocks.gitCommit.mockResolvedValue(undefined);
    gitMocks.gitCheckoutBranch.mockReset();
    gitMocks.gitCheckoutBranch.mockResolvedValue(undefined);
    gitMocks.gitCreateBranch.mockReset();
    gitMocks.gitCreateBranch.mockResolvedValue(undefined);
    gitMocks.gitFetch.mockReset();
    gitMocks.gitFetch.mockResolvedValue(undefined);
    gitMocks.gitPull.mockReset();
    gitMocks.gitPull.mockResolvedValue(undefined);
    gitMocks.gitPush.mockReset();
    gitMocks.gitPush.mockResolvedValue(undefined);
    gitMocks.gitStage.mockReset();
    gitMocks.gitStage.mockResolvedValue(undefined);
    gitMocks.gitUnstage.mockReset();
    gitMocks.gitUnstage.mockResolvedValue(undefined);
    gitMocks.gitDiscard.mockReset();
    gitMocks.gitDiscard.mockResolvedValue(undefined);
    gitMocks.gitCleanUntracked.mockReset();
    gitMocks.gitCleanUntracked.mockResolvedValue(undefined);
    gitMocks.gitSnapshot.mockReset();
    gitMocks.gitSnapshot.mockImplementation(async (repoRoot: string) => (
      repoRoot === "/repo/app"
        ? snapshot("/repo/app", [{
          path: "src/App.tsx",
          oldPath: null,
          status: "modified",
          staged: false,
          unstaged: true,
          conflict: false,
        }, {
          path: "src/ignored.ts",
          oldPath: null,
          status: "modified",
          staged: false,
          unstaged: true,
          conflict: false,
        }])
        : snapshot(repoRoot)
    ));
    gitMocks.selectedRemote.mockReset();
    gitMocks.selectedRemote.mockReturnValue(null);
    dialogMocks.alertAppDialog.mockReset();
    dialogMocks.choiceAppDialog.mockReset();
    dialogMocks.choiceAppDialog.mockResolvedValue("primary");
    dialogMocks.confirmAppDialog.mockReset();
    dialogMocks.confirmAppDialog.mockResolvedValue(true);
    workspaceMocks.workspaceWriteFile.mockReset();
    workspaceMocks.workspaceWriteFile.mockResolvedValue({
      path: "src/App.tsx",
      text: "old",
      size: 3,
      mtime: 0,
      hash: "h",
    });
  });

  afterEach(() => {
    cleanup();
  });
  registerWorkspaceGitManagerEditing1Cases();
  registerWorkspaceGitManagerBehavior2Cases();
});
