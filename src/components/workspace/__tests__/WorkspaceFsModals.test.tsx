import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { WorkspaceFsModals, type WorkspaceFsModalRequest } from "../WorkspaceFsModals";
import { selectFolderPath } from "../../../lib/ipc";

vi.mock("../../../lib/ipc", () => ({ selectFolderPath: vi.fn() }));

const rootRequest: WorkspaceFsModalRequest = { kind: "root", directory: "" };

beforeEach(() => vi.mocked(selectFolderPath).mockReset());
afterEach(cleanup);

describe("Workspace folder selection", () => {
  it("starts in the workspace root and waits for Add before mounting the chosen directory", async () => {
    vi.mocked(selectFolderPath).mockResolvedValue("/repo/extra folder");
    const onSubmit = vi.fn();
    render(<WorkspaceFsModals request={rootRequest} initialPath="/repo" onCancel={vi.fn()} onSubmit={onSubmit} />);

    fireEvent.click(screen.getByTestId("workspace-fs-modal-browse"));
    await waitFor(() => expect(screen.getByTestId("workspace-fs-modal-input")).toHaveValue("/repo/extra folder"));
    expect(selectFolderPath).toHaveBeenCalledWith("/repo");
    expect(onSubmit).not.toHaveBeenCalled();
    fireEvent.click(screen.getByTestId("workspace-fs-modal-confirm"));
    await waitFor(() => expect(onSubmit).toHaveBeenCalledWith("/repo/extra folder"));
  });

  it("opens at the typed path and preserves it when the system picker is cancelled", async () => {
    vi.mocked(selectFolderPath).mockResolvedValue(null);
    render(<WorkspaceFsModals request={rootRequest} onCancel={vi.fn()} onSubmit={vi.fn()} />);
    fireEvent.change(screen.getByTestId("workspace-fs-modal-input"), { target: { value: " /repo/typed " } });
    fireEvent.click(screen.getByTestId("workspace-fs-modal-browse"));

    await waitFor(() => expect(screen.getByTestId("workspace-fs-modal-browse")).toBeEnabled());
    expect(selectFolderPath).toHaveBeenCalledWith("/repo/typed");
    expect(screen.getByTestId("workspace-fs-modal-input")).toHaveValue(" /repo/typed ");
    expect(screen.getByTestId("workspace-fs-modal-input")).toHaveFocus();
  });

  it("shows selection failures and supports retry without losing the entered path", async () => {
    vi.mocked(selectFolderPath).mockRejectedValueOnce(new Error("Directory chooser unavailable")).mockResolvedValueOnce("/repo/retried");
    render(<WorkspaceFsModals request={rootRequest} onCancel={vi.fn()} onSubmit={vi.fn()} />);
    fireEvent.change(screen.getByTestId("workspace-fs-modal-input"), { target: { value: "/repo/original" } });
    fireEvent.click(screen.getByTestId("workspace-fs-modal-browse"));
    expect(await screen.findByRole("alert")).toHaveTextContent("Directory chooser unavailable");
    expect(screen.getByTestId("workspace-fs-modal-input")).toHaveValue("/repo/original");
    fireEvent.click(screen.getByTestId("workspace-fs-modal-browse"));
    await waitFor(() => expect(screen.getByTestId("workspace-fs-modal-input")).toHaveValue("/repo/retried"));
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
  });

  it("prevents duplicate pickers and mounting a path while selection is pending", async () => {
    let resolve!: (path: string | null) => void;
    vi.mocked(selectFolderPath).mockReturnValue(new Promise((done) => { resolve = done; }));
    const onSubmit = vi.fn();
    render(<WorkspaceFsModals request={rootRequest} onCancel={vi.fn()} onSubmit={onSubmit} />);
    fireEvent.change(screen.getByTestId("workspace-fs-modal-input"), { target: { value: "/repo" } });
    fireEvent.click(screen.getByTestId("workspace-fs-modal-browse"));
    expect(screen.getByTestId("workspace-fs-modal-browse")).toBeDisabled();
    expect(screen.getByTestId("workspace-fs-modal-confirm")).toBeDisabled();
    fireEvent.click(screen.getByTestId("workspace-fs-modal-browse"));
    fireEvent.keyDown(screen.getByTestId("workspace-fs-modal-input"), { key: "Enter" });
    expect(selectFolderPath).toHaveBeenCalledTimes(1);
    expect(onSubmit).not.toHaveBeenCalled();
    await act(async () => resolve(null));
    expect(screen.getByTestId("workspace-fs-modal-confirm")).toBeEnabled();
  });

  it("ignores a completed picker after closing the dialog and opening a different request", async () => {
    let resolve!: (path: string | null) => void;
    vi.mocked(selectFolderPath).mockReturnValue(new Promise((done) => { resolve = done; }));
    const props = { onCancel: vi.fn(), onSubmit: vi.fn() };
    const view = render(<WorkspaceFsModals request={rootRequest} {...props} />);
    fireEvent.click(screen.getByTestId("workspace-fs-modal-browse"));
    view.rerender(<WorkspaceFsModals request={null} {...props} />);
    view.rerender(<WorkspaceFsModals request={{ kind: "file", directory: "src" }} {...props} />);
    fireEvent.change(screen.getByTestId("workspace-fs-modal-input"), { target: { value: "keep.ts" } });
    await act(async () => resolve("/repo/stale"));
    expect(screen.getByTestId("workspace-fs-modal-input")).toHaveValue("keep.ts");
    expect(screen.queryByTestId("workspace-fs-modal-browse")).not.toBeInTheDocument();
  });
});

it("offers a new workspace named from the selected folder and preserves a custom name", async () => {
  const onSubmit = vi.fn();
  render(<WorkspaceFsModals request={rootRequest} onCancel={vi.fn()} onSubmit={onSubmit} />);
  fireEvent.change(screen.getByTestId("workspace-fs-modal-input"), { target: { value: "C:\\projects\\my app\\" } });
  fireEvent.click(screen.getByTestId("workspace-root-new"));
  expect(screen.getByTestId("workspace-root-name")).toHaveValue("my app");
  fireEvent.change(screen.getByTestId("workspace-fs-modal-input"), { target: { value: "/projects/other/" } });
  expect(screen.getByTestId("workspace-root-name")).toHaveValue("other");
  fireEvent.change(screen.getByTestId("workspace-root-name"), { target: { value: " Team A " } });
  fireEvent.change(screen.getByTestId("workspace-fs-modal-input"), { target: { value: "/projects/third" } });
  expect(screen.getByTestId("workspace-root-name")).toHaveValue(" Team A ");
  fireEvent.click(screen.getByTestId("workspace-fs-modal-confirm"));
  await waitFor(() => expect(onSubmit).toHaveBeenCalledWith("/projects/third", { newWorkspaceName: "Team A" }));
});

it("rejects empty workspace names and IME Enter, while cancellation has no mutation", () => {
  const onSubmit = vi.fn(), onCancel = vi.fn();
  render(<WorkspaceFsModals request={rootRequest} onCancel={onCancel} onSubmit={onSubmit} />);
  fireEvent.change(screen.getByTestId("workspace-fs-modal-input"), { target: { value: "/repo/project" } });
  fireEvent.click(screen.getByTestId("workspace-root-new"));
  const name = screen.getByTestId("workspace-root-name");
  fireEvent.keyDown(name, { key: "Enter", isComposing: true });
  expect(onSubmit).not.toHaveBeenCalled();
  fireEvent.change(name, { target: { value: "  " } });
  expect(screen.getByTestId("workspace-fs-modal-confirm")).toBeDisabled();
  fireEvent.click(screen.getByTestId("workspace-fs-modal-cancel"));
  expect(onSubmit).not.toHaveBeenCalled();
  expect(onCancel).toHaveBeenCalledOnce();
});

it("uses top-layer dialog semantics, respects IME Escape, and restores opener focus on dismissal", () => {
  const opener = document.createElement("button");
  document.body.append(opener);
  opener.focus();
  const onCancel = vi.fn();

  const view = render(<WorkspaceFsModals request={{ kind: "file", directory: "src" }} onCancel={onCancel} onSubmit={vi.fn()} />);
  const dialog = screen.getByTestId("workspace-fs-modal");
  expect(dialog.tagName).toBe("DIALOG");
  const input = screen.getByTestId("workspace-fs-modal-input");
  expect(input).toHaveFocus();

  fireEvent.keyDown(input, { key: "Escape", isComposing: true });
  expect(onCancel).not.toHaveBeenCalled();

  fireEvent.keyDown(input, { key: "Escape" });
  expect(onCancel).toHaveBeenCalledTimes(1);

  view.rerender(<WorkspaceFsModals request={null} onCancel={onCancel} onSubmit={vi.fn()} />);
  expect(opener).toHaveFocus();
  opener.remove();
});
