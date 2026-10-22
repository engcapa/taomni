import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { expect, it } from "vitest";
import { WorkspaceGitManager } from "../../WorkspaceGitManager";
import { change, dialogMocks, gitMocks, originSnapshot, snapshot } from "./harness";

export function registerWorkspaceGitManagerBehavior2Cases() {

  it("runs header fetch only for repositories in a custom scope", async () => {
    gitMocks.gitSnapshot.mockImplementation(async (repoRoot: string) => {
      if (repoRoot === "/repo/app") return originSnapshot(repoRoot, [change("src/app.ts")]);
      if (repoRoot === "/repo/api") return originSnapshot(repoRoot, [change("src/api.ts")]);
      return originSnapshot(repoRoot, [change("src/service.ts")]);
    });

    render(
      <WorkspaceGitManager
        workspaceName="Workspace"
        activeRepoRoot="/repo/app"
        roots={[
          { id: "app", name: "app", path: "/repo", repoRoot: "/repo/app", rootIds: ["root"] },
          { id: "api", name: "api", path: "/repo", repoRoot: "/repo/api", rootIds: ["root"] },
          { id: "service", name: "service", path: "/repo", repoRoot: "/repo/service", rootIds: ["root"] },
        ]}
      />,
    );

    await waitFor(() => expect(screen.getByRole("button", { name: /service src\/service\.ts Modified/i })).toBeInTheDocument());

    fireEvent.click(screen.getByTestId("workspace-repo-selector"));
    const menu = screen.getByTestId("workspace-repo-selector-menu");
    fireEvent.click(within(menu).getByRole("checkbox", { name: "Include service" }));
    fireEvent.click(within(menu).getByRole("button", { name: "Apply" }));
    fireEvent.click(screen.getByRole("button", { name: "Fetch" }));

    await waitFor(() => expect(gitMocks.gitFetch).toHaveBeenCalledTimes(2));
    expect(gitMocks.gitFetch).toHaveBeenCalledWith("/repo/app", "origin");
    expect(gitMocks.gitFetch).toHaveBeenCalledWith("/repo/api", "origin");
    expect(gitMocks.gitFetch).not.toHaveBeenCalledWith("/repo/service", "origin");
  });

  it("does not stage or commit outside the custom repository scope", async () => {
    gitMocks.gitSnapshot.mockImplementation(async (repoRoot: string) => {
      if (repoRoot === "/repo/app") return snapshot(repoRoot, [change("src/app.ts")]);
      if (repoRoot === "/repo/api") return snapshot(repoRoot, [change("src/api.ts")]);
      return snapshot(repoRoot, [change("src/service.ts")]);
    });

    render(
      <WorkspaceGitManager
        workspaceName="Workspace"
        activeRepoRoot="/repo/app"
        roots={[
          { id: "app", name: "app", path: "/repo", repoRoot: "/repo/app", rootIds: ["root"] },
          { id: "api", name: "api", path: "/repo", repoRoot: "/repo/api", rootIds: ["root"] },
          { id: "service", name: "service", path: "/repo", repoRoot: "/repo/service", rootIds: ["root"] },
        ]}
      />,
    );

    await waitFor(() => expect(screen.getByRole("button", { name: /service src\/service\.ts Modified/i })).toBeInTheDocument());

    fireEvent.click(screen.getByTestId("workspace-repo-selector"));
    const menu = screen.getByTestId("workspace-repo-selector-menu");
    fireEvent.click(within(menu).getByRole("checkbox", { name: "Include service" }));
    fireEvent.click(within(menu).getByRole("button", { name: "Apply" }));

    fireEvent.click(screen.getByRole("button", { name: /^Stage visible changes/i }));
    await waitFor(() => expect(gitMocks.gitStage).toHaveBeenCalledTimes(2));
    expect(gitMocks.gitStage).toHaveBeenCalledWith("/repo/app", ["src/app.ts"]);
    expect(gitMocks.gitStage).toHaveBeenCalledWith("/repo/api", ["src/api.ts"]);
    expect(gitMocks.gitStage).not.toHaveBeenCalledWith("/repo/service", ["src/service.ts"]);

    fireEvent.change(screen.getByPlaceholderText("Commit message"), {
      target: { value: "scoped commit" },
    });
    await waitFor(() => expect(screen.getByRole("button", { name: "Commit" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "Commit" }));

    await waitFor(() => expect(gitMocks.gitCommit).toHaveBeenCalledTimes(2));
    expect(gitMocks.gitCommit).toHaveBeenCalledWith(
      "/repo/app",
      "scoped commit",
      false,
      ["src/app.ts"],
    );
    expect(gitMocks.gitCommit).toHaveBeenCalledWith(
      "/repo/api",
      "scoped commit",
      false,
      ["src/api.ts"],
    );
    expect(gitMocks.gitCommit).not.toHaveBeenCalledWith(
      "/repo/service",
      "scoped commit",
      false,
      ["src/service.ts"],
    );
  });

  it("lets commit and push fall back to commit only from the confirmation dialog", async () => {
    gitMocks.selectedRemote.mockImplementation((snapshotArg) => snapshotArg?.remotes[0] ?? null);
    gitMocks.gitSnapshot.mockImplementation(async (repoRoot: string) => originSnapshot(repoRoot, [change("src/app.ts")]));
    dialogMocks.choiceAppDialog.mockResolvedValue("secondary");

    render(
      <WorkspaceGitManager
        workspaceName="Workspace"
        activeRepoRoot="/repo/app"
        roots={[
          { id: "app", name: "app", path: "/repo", repoRoot: "/repo/app", rootIds: ["root"] },
          { id: "api", name: "api", path: "/repo", repoRoot: "/repo/api", rootIds: ["root"] },
        ]}
      />,
    );

    await waitFor(() => expect(screen.getByRole("button", { name: /app src\/app\.ts Modified/i })).toBeInTheDocument());
    fireEvent.change(screen.getByPlaceholderText("Commit message"), {
      target: { value: "commit without push" },
    });
    await waitFor(() => expect(screen.getByRole("button", { name: "Commit and Push" })).toBeEnabled());
    fireEvent.click(screen.getByRole("button", { name: "Commit and Push" }));

    await waitFor(() => expect(dialogMocks.choiceAppDialog).toHaveBeenCalledWith(expect.objectContaining({
      title: "Confirm Commit and Push",
      primaryLabel: "Commit and Push",
      secondaryLabel: "Commit only",
    })));
    await waitFor(() => expect(gitMocks.gitCommit).toHaveBeenCalledTimes(2));
    expect(gitMocks.gitPush).not.toHaveBeenCalled();
  });

  it("requires confirmation before pushing workspace repositories", async () => {
    gitMocks.gitSnapshot.mockImplementation(async (repoRoot: string) => originSnapshot(repoRoot, [change("src/app.ts")]));
    dialogMocks.confirmAppDialog.mockResolvedValue(false);

    render(
      <WorkspaceGitManager
        workspaceName="Workspace"
        activeRepoRoot="/repo/app"
        roots={[
          { id: "app", name: "app", path: "/repo", repoRoot: "/repo/app", rootIds: ["root"] },
          { id: "api", name: "api", path: "/repo", repoRoot: "/repo/api", rootIds: ["root"] },
        ]}
      />,
    );

    await waitFor(() => expect(screen.getByRole("button", { name: /app src\/app\.ts Modified/i })).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "Push" }));

    await waitFor(() => expect(dialogMocks.confirmAppDialog).toHaveBeenCalledWith(expect.objectContaining({
      title: "Confirm Push",
      confirmLabel: "Push",
    })));
    expect(gitMocks.gitPush).not.toHaveBeenCalled();
  });
}
