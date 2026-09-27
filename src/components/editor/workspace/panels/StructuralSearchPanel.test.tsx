import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { StructuralSearchPanel } from "./StructuralSearchPanel";
import type { CodeWorkspaceRootInfo } from "../../../../types";

const workspaceMocks = vi.hoisted(() => ({
  workspaceListFilesRecursive: vi.fn(),
  workspaceReadFile: vi.fn(),
}));

vi.mock("../../../../lib/editor/workspace", () => workspaceMocks);

const roots: CodeWorkspaceRootInfo[] = [{
  id: "root-1",
  name: "fixture",
  path: "/fixture",
  kind: "folder",
}];

const source = `class StructuralTarget {
  void run() {
    System.out.println("one");
    System.out.println(42);
    System.out.println(
      7
    );
    // System.out.println(99);
    String fake = "System.out.println(100);";
    System.out.print(1);
    System.err.println(2);
  }
}`;

function file(path: string, text: string) {
  return {
    path,
    text,
    size: text.length,
    mtime: 0,
    hash: "fixture-hash",
  };
}

describe("StructuralSearchPanel", () => {
  beforeEach(() => {
    workspaceMocks.workspaceListFilesRecursive.mockReset().mockResolvedValue({
      state: "ready",
      entries: [
        { name: "StructuralTarget.java", path: "StructuralTarget.java", fileType: "file" },
        { name: "README.md", path: "README.md", fileType: "file" },
      ],
      truncated: false,
    });
    workspaceMocks.workspaceReadFile.mockReset().mockResolvedValue(file("StructuralTarget.java", source));
  });

  afterEach(() => cleanup());

  it("renders three AST results, expands the file tree, and navigates a result", async () => {
    const onOpenResult = vi.fn();
    render(<StructuralSearchPanel roots={roots} onOpenResult={onOpenResult} onClose={vi.fn()} />);

    fireEvent.click(screen.getByTestId("structural-search-submit"));
    await waitFor(() => expect(screen.getByTestId("structural-search-status")).toHaveTextContent("3 results"));
    expect(screen.getByTestId("structural-search-status")).toHaveTextContent("lezer-java");
    expect(screen.getByTestId("structural-search-file")).toHaveAttribute("data-path", "StructuralTarget.java");
    expect(screen.queryAllByTestId("structural-search-result")).toHaveLength(0);

    fireEvent.click(screen.getByTestId("structural-search-file"));
    expect(screen.getAllByTestId("structural-search-result")).toHaveLength(3);
    fireEvent.click(screen.getAllByTestId("structural-search-result")[1]!);
    expect(onOpenResult).toHaveBeenCalledWith(expect.objectContaining({
      path: "StructuralTarget.java",
      preview: "System.out.println(42);",
    }));
  });

  it("filters Text=42 to one result and keeps Text=999 as a ready empty state", async () => {
    render(<StructuralSearchPanel roots={roots} onOpenResult={vi.fn()} onClose={vi.fn()} />);
    fireEvent.change(screen.getByTestId("structural-search-text"), { target: { value: "42" } });
    fireEvent.click(screen.getByTestId("structural-search-submit"));
    await waitFor(() => expect(screen.getByTestId("structural-search-status")).toHaveTextContent("1 result"));

    fireEvent.change(screen.getByTestId("structural-search-text"), { target: { value: "999" } });
    fireEvent.click(screen.getByTestId("structural-search-submit"));
    await waitFor(() => expect(screen.getByTestId("structural-search-empty")).toBeInTheDocument());
    expect(screen.getByTestId("structural-search-status")).toHaveTextContent("0 results");
  });

  it("shows typed unavailable and error states, and closes on Escape", async () => {
    const onClose = vi.fn();
    render(<StructuralSearchPanel roots={roots} onOpenResult={vi.fn()} onClose={onClose} />);
    fireEvent.change(screen.getByTestId("structural-search-pattern"), { target: { value: "System.out.print($arg$);" } });
    fireEvent.click(screen.getByTestId("structural-search-submit"));
    await waitFor(() => expect(screen.getByTestId("structural-search-status")).toHaveTextContent("Unavailable"));
    expect(screen.getByTestId("structural-search-status")).toHaveTextContent("Only the Java println template");

    workspaceMocks.workspaceReadFile.mockRejectedValueOnce(new Error("fixture read failed"));
    fireEvent.change(screen.getByTestId("structural-search-pattern"), { target: { value: "System.out.println($arg$);" } });
    fireEvent.click(screen.getByTestId("structural-search-submit"));
    await waitFor(() => expect(screen.getByTestId("structural-search-status")).toHaveTextContent("Search failed"));
    expect(screen.getByTestId("structural-search-status")).toHaveTextContent("fixture read failed");

    fireEvent.keyDown(screen.getByTestId("structural-search-panel"), { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("cancels a slow document load without publishing a result", async () => {
    let release!: (value: unknown) => void;
    workspaceMocks.workspaceListFilesRecursive.mockImplementationOnce(() => new Promise((resolve) => {
      release = resolve;
    }));
    render(<StructuralSearchPanel roots={roots} onOpenResult={vi.fn()} onClose={vi.fn()} />);

    fireEvent.click(screen.getByTestId("structural-search-submit"));
    await waitFor(() => expect(screen.getByTestId("structural-search-cancel")).toBeInTheDocument());
    fireEvent.click(screen.getByTestId("structural-search-cancel"));
    expect(screen.getByTestId("structural-search-status")).toHaveTextContent("Search cancelled");

    await act(async () => {
      release({
        state: "ready",
        entries: [],
        truncated: false,
      });
      await Promise.resolve();
    });
    expect(screen.queryByTestId("structural-search-result")).not.toBeInTheDocument();
  });

  it("cancels a pending search when the dock is hidden", async () => {
    let release!: (value: unknown) => void;
    workspaceMocks.workspaceListFilesRecursive.mockImplementationOnce(() => new Promise((resolve) => {
      release = resolve;
    }));
    const { rerender } = render(
      <StructuralSearchPanel roots={roots} active onOpenResult={vi.fn()} onClose={vi.fn()} />,
    );
    fireEvent.click(screen.getByTestId("structural-search-submit"));
    await waitFor(() => expect(screen.getByTestId("structural-search-cancel")).toBeInTheDocument());
    rerender(<StructuralSearchPanel roots={roots} active={false} onOpenResult={vi.fn()} onClose={vi.fn()} />);
    expect(screen.getByTestId("structural-search-status")).toHaveTextContent("Search cancelled");
    await act(async () => {
      release({ state: "ready", entries: [], truncated: false });
      await Promise.resolve();
    });
    expect(screen.queryByTestId("structural-search-empty")).not.toBeInTheDocument();
  });

  it("cancels a pending search when the close button is used", async () => {
    let release!: (value: unknown) => void;
    workspaceMocks.workspaceListFilesRecursive.mockImplementationOnce(() => new Promise((resolve) => {
      release = resolve;
    }));
    const onClose = vi.fn();
    render(<StructuralSearchPanel roots={roots} onOpenResult={vi.fn()} onClose={onClose} />);
    fireEvent.click(screen.getByTestId("structural-search-submit"));
    await waitFor(() => expect(screen.getByTestId("structural-search-cancel")).toBeInTheDocument());
    fireEvent.click(screen.getByRole("button", { name: "Close structural search" }));
    expect(onClose).toHaveBeenCalledTimes(1);
    expect(screen.getByTestId("structural-search-status")).toHaveTextContent("Search cancelled");
    await act(async () => {
      release({ state: "ready", entries: [], truncated: false });
      await Promise.resolve();
    });
    expect(screen.queryByTestId("structural-search-empty")).not.toBeInTheDocument();
  });
});
