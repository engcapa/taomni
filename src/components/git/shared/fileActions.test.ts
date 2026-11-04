import { beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import * as clipboard from "../../../lib/clipboard";
import { useAppStore } from "../../../stores/appStore";
import { useWorkspacePlatformStore } from "../../../stores/workspacePlatformStore";
import { gitFileAbsolutePath, gitFileMenuItems } from "./fileActions";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("../../../lib/clipboard", () => ({ writeText: vi.fn() }));

async function select(id: string, targets = [{ repoRoot: "/repo", path: "src/deleted.ts" }]) {
  gitFileMenuItems(targets).find((item) => item.testId === id)!.onClick!();
  await vi.waitFor(() => expect(useAppStore.getState().statusMessage).not.toBe("Ready"));
}

describe("Git file actions", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    vi.mocked(clipboard.writeText).mockResolvedValue();
    useAppStore.setState({ statusMessage: "Ready", activeSideTab: "sessions" });
  });

  it.each([
    ["/", "src/a.ts", "/src/a.ts"],
    ["/repo/", "src/a.ts", "/repo/src/a.ts"],
    ["C:\\repo\\", "src/文件.ts", "C:\\repo\\src\\文件.ts"],
    ["C:/repo/", "src/a.ts", "C:/repo/src/a.ts"],
    ["\\\\server\\share\\", "src/a.ts", "\\\\server\\share\\src\\a.ts"],
  ])("joins repository %s and Git path %s", (repoRoot, path, expected) => {
    expect(gitFileAbsolutePath({ repoRoot, path })).toBe(expected);
  });

  it("preserves multi-repository copy names and newline separation", async () => {
    const targets = [
      { repoRoot: "/repo/a", repoName: "a", path: "src/same.ts" },
      { repoRoot: "/repo/b", repoName: "b", path: "src/same.ts" },
    ];
    await select("git-file-copy-path", targets);
    expect(clipboard.writeText).toHaveBeenLastCalledWith("/repo/a/src/same.ts\n/repo/b/src/same.ts");
    useAppStore.setState({ statusMessage: "Ready" });
    await select("git-file-copy-relative-path", targets);
    expect(clipboard.writeText).toHaveBeenLastCalledWith("a: src/same.ts\nb: src/same.ts");
  });

  it("opens the clicked file's parent without requiring a historical file to exist", async () => {
    const targets = [{ repoRoot: "/repo/a", path: "old.ts" }, { repoRoot: "/repo/b", path: "src/deleted.ts" }];
    gitFileMenuItems(targets, targets[1]).find((item) => item.testId === "git-file-reveal")!.onClick!();
    await vi.waitFor(() => expect(invoke).toHaveBeenCalledWith("sftp_open_path", { path: "/repo/b/src" }));
  });

  it("surfaces clipboard and missing-directory errors", async () => {
    vi.mocked(clipboard.writeText).mockRejectedValue(new Error("Clipboard unavailable"));
    await select("git-file-copy-path");
    expect(useAppStore.getState().statusMessage).toBe("Clipboard unavailable");
    vi.mocked(invoke).mockRejectedValue(new Error("Path does not exist: /repo/src"));
    useAppStore.setState({ statusMessage: "Ready" });
    await select("git-file-reveal");
    expect(useAppStore.getState().statusMessage).toBe("Path does not exist: /repo/src");
  });

  it("opens a workspace terminal in the parent directory and retains Git", async () => {
    const platform = useWorkspacePlatformStore.getState();
    const workspace = platform.createWorkspace({ name: "Git file actions" });
    platform.setActiveWorkspace(workspace.id);
    const gitTab = platform.openGitTab(workspace.id);
    useAppStore.setState({ activeSideTab: "workspaces" });
    await select("git-file-open-terminal");
    const current = platform.getWorkspace(workspace.id)!;
    const terminal = current.openTabs.find((tab) => tab.id === current.activeTabId)!;
    expect(terminal).toMatchObject({ kind: "terminal", terminalInitialCwd: "/repo/src" });
    expect(current.openTabs).toContainEqual(gitTab);
    expect(useAppStore.getState().activeSideTab).toBe("workspaces");
  });

  it("opens a regular Git tab's terminal with the configured profile", async () => {
    const previous = useAppStore.getState().tabs.map((tab) => tab.id);
    await select("git-file-open-terminal");
    const terminal = useAppStore.getState().tabs.find((tab) => !previous.includes(tab.id));
    expect(terminal).toMatchObject({ type: "terminal", terminalInitialCwd: "/repo/src", closable: true });
    expect(terminal?.terminalProfile).toBeDefined();
  });
});
