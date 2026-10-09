import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { WorkspaceGitSurface } from "./WorkspaceGitSurface";
import { workspaceDetectGitRoots } from "../../lib/editor/workspace";
import type { Workspace } from "../../types/workspace";

vi.mock("../../lib/editor/workspace", () => ({ workspaceDetectGitRoots: vi.fn() }));
vi.mock("./WorkspaceGitManager", () => ({ WorkspaceGitManager: ({ roots }: { roots: { repoRoot: string }[] }) => <div>{roots.map((root) => root.repoRoot).join(",")}</div> }));
afterEach(() => { cleanup(); vi.resetAllMocks(); });
const workspace = (path: string) => ({ id: "owner", name: "Project", roots: [{ id: path, name: path, path }] }) as Workspace;

it("rejects a late detection for replaced folders", async () => {
  let finish!: (roots: { repoRoot: string }[]) => void;
  vi.mocked(workspaceDetectGitRoots).mockImplementationOnce(() => new Promise((resolve) => { finish = resolve as typeof finish; })).mockResolvedValueOnce([{ id: "b", name: "b", path: "/b", repoRoot: "/b", rootIds: ["b"] }]);
  const view = render(<WorkspaceGitSurface workspace={workspace("/a")} visible onOpenWorkspace={() => {}} />);
  view.rerender(<WorkspaceGitSurface workspace={workspace("/b")} visible onOpenWorkspace={() => {}} />);
  await screen.findByText("/b");
  await act(async () => finish([{ repoRoot: "/a" }]));
  expect(screen.queryByText("/a")).not.toBeInTheDocument();
});

it("surfaces detection failure and allows retry to a genuine empty repository state", async () => {
  vi.mocked(workspaceDetectGitRoots).mockRejectedValueOnce(new Error("folder unavailable")).mockResolvedValueOnce([]);
  render(<WorkspaceGitSurface workspace={workspace("/a")} visible onOpenWorkspace={() => {}} />);
  expect(await screen.findByRole("alert")).toHaveTextContent("folder unavailable");
  fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  await waitFor(() => expect(screen.getByRole("status")).toHaveTextContent("No Git repository"));
});
