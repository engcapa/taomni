import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { WorkspaceGitRoot } from "../../lib/editor/workspace";
import { WorkspaceGitContainer } from "./WorkspaceGitContainer";

vi.mock("../git/GitPanel", () => ({
  GitPanel: ({ repoRoot, embedded }: { repoRoot: string; embedded?: boolean }) => (
    <div data-testid="git-panel" data-repo-root={repoRoot} data-embedded={embedded ? "true" : "false"} />
  ),
}));

function gitRoot(overrides: Partial<WorkspaceGitRoot>): WorkspaceGitRoot {
  return {
    id: "app",
    name: "app",
    path: "/repo/app",
    repoRoot: "/repo/app",
    rootIds: ["app"],
    ...overrides,
  };
}

describe("WorkspaceGitContainer", () => {
  it("selects the active file repository while allowing manual repo switches", async () => {
    render(
      <WorkspaceGitContainer
        visible
        activeRootId="lib"
        gitRoots={[
          gitRoot({ id: "app", name: "app", repoRoot: "/repo/app", rootIds: ["app"] }),
          gitRoot({ id: "lib", name: "lib", path: "/repo/lib", repoRoot: "/repo/lib", rootIds: ["lib"] }),
        ]}
      />,
    );

    await waitFor(() => {
      expect(screen.getByTestId("workspace-git-repo-select")).toHaveValue("/repo/lib");
      expect(screen.getByTestId("git-panel")).toHaveAttribute("data-repo-root", "/repo/lib");
    });
    expect(screen.getByTestId("git-panel")).toHaveAttribute("data-embedded", "true");

    fireEvent.change(screen.getByTestId("workspace-git-repo-select"), {
      target: { value: "/repo/app" },
    });

    expect(screen.getByTestId("git-panel")).toHaveAttribute("data-repo-root", "/repo/app");
  });
});
