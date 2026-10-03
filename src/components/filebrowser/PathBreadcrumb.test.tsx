import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PathBreadcrumb } from "./PathBreadcrumb";
import type { FileEntry } from "../../lib/sftp";

function dir(name: string, parent = "/work"): FileEntry {
  return { name, path: `${parent}/${name}`, size: 0, mtime: 0, mode: 0, fileType: "dir", isHidden: name.startsWith(".") };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => { cleanup(); vi.useRealTimers(); });

async function loadSuggestions() {
  await act(async () => { await vi.advanceTimersByTimeAsync(125); });
}

function mount(listDirectory = vi.fn(async (_path: string) => [dir("Projects"), dir("Project notes"), dir("Documents")])) {
  const onNavigate = vi.fn();
  const onSubmit = vi.fn();
  render(<PathBreadcrumb path="/work" testId="path" onNavigate={onNavigate} onSubmit={onSubmit} listDirectory={listDirectory} />);
  fireEvent.click(screen.getByTestId("path-edit"));
  const input = screen.getByRole("combobox") as HTMLInputElement;
  return { input, onNavigate, onSubmit, listDirectory };
}

describe("address bar completion", () => {
  it("automatically lists matching directories and completes a unique match without navigating", async () => {
    const { input, onSubmit, onNavigate } = mount();
    fireEvent.change(input, { target: { value: "/work/Doc" } });
    await loadSuggestions();
    expect(screen.getAllByRole("option")).toHaveLength(1);
    fireEvent.keyDown(input, { key: "Tab" });
    expect(input).toHaveValue("/work/Documents/");
    expect(input).toHaveFocus();
    expect(onSubmit).not.toHaveBeenCalled();
    expect(onNavigate).not.toHaveBeenCalled();
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onSubmit).toHaveBeenCalledExactlyOnceWith("/work/Documents/");
  });

  it("extends an ambiguous common prefix, then uses the highlighted candidate", async () => {
    const { input } = mount();
    fireEvent.change(input, { target: { value: "/work/Pro" } });
    await loadSuggestions();
    fireEvent.keyDown(input, { key: "Tab" });
    expect(input).toHaveValue("/work/Project");
    fireEvent.keyDown(input, { key: "ArrowUp" });
    expect(screen.getAllByRole("option")[1]).toHaveAttribute("aria-selected", "true");
    fireEvent.keyDown(input, { key: "Tab" });
    expect(input).toHaveValue("/work/Projects/");
  });

  it("navigates to a keyboard-selected directory on Enter", async () => {
    const { input, onSubmit } = mount();
    fireEvent.change(input, { target: { value: "/work/Pro" } });
    await loadSuggestions();
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "ArrowDown" });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onSubmit).toHaveBeenCalledExactlyOnceWith("/work/Projects/");
  });

  it("mouse selection retains input focus and permits completion into a nested directory", async () => {
    const listing = vi.fn(async (path: string) => path === "/work/Projects/" ? [dir("Child space", "/work/Projects")] : [dir("Projects")]);
    const { input, onSubmit } = mount(listing);
    fireEvent.change(input, { target: { value: "/work/Pro" } });
    await loadSuggestions();
    fireEvent.mouseDown(screen.getByRole("option"));
    fireEvent.click(screen.getByRole("option"));
    expect(input).toHaveValue("/work/Projects/");
    expect(input).toHaveFocus();
    expect(onSubmit).not.toHaveBeenCalled();
    await loadSuggestions();
    fireEvent.keyDown(input, { key: "Tab" });
    expect(input).toHaveValue("/work/Projects/Child space/");
  });

  it("keeps pending Tab completion bound to the input that requested it", async () => {
    const { input } = mount();
    fireEvent.change(input, { target: { value: "/work/Doc" } });
    fireEvent.keyDown(input, { key: "Tab" });
    await loadSuggestions();
    expect(input).toHaveValue("/work/Documents/");
    fireEvent.change(input, { target: { value: "/other/Ch" } });
    fireEvent.keyDown(input, { key: "Tab" });
    fireEvent.change(input, { target: { value: "/work/Pro" } });
    await loadSuggestions();
    expect(input).toHaveValue("/work/Pro");
  });

  it("ignores a late result from an old parent and a result after cancellation", async () => {
    let finishOld: (entries: FileEntry[]) => void = () => {};
    const listing = vi.fn((path: string) => path === "/old/" ? new Promise<FileEntry[]>((resolve) => { finishOld = resolve; }) : Promise.resolve([dir("New", "/new")]));
    const { input, onSubmit } = mount(listing);
    fireEvent.change(input, { target: { value: "/old/O" } });
    await loadSuggestions();
    fireEvent.change(input, { target: { value: "/new/N" } });
    await loadSuggestions();
    await act(async () => finishOld([dir("Old", "/old")]));
    expect(screen.getByRole("option")).toHaveTextContent("/new/New/");
    fireEvent.keyDown(input, { key: "Escape" });
    expect(screen.queryByRole("listbox")).not.toBeInTheDocument();
    expect(onSubmit).not.toHaveBeenCalled();
  });

  it("allows manual navigation after a lookup failure and does not trap Tab without candidates", async () => {
    const { input, onSubmit } = mount(vi.fn(async () => { throw new Error("Permission denied"); }));
    fireEvent.change(input, { target: { value: "'/protected/path'" } });
    await loadSuggestions();
    expect(screen.getByRole("status")).toHaveTextContent("Cannot list folders");
    expect(fireEvent.keyDown(input, { key: "Tab" })).toBe(true);
    fireEvent.blur(input);
    expect(onSubmit).toHaveBeenCalledExactlyOnceWith("/protected/path");
  });

  it("suppresses completion and Enter while composing text, then queries the committed input", async () => {
    const { input, listDirectory, onSubmit } = mount(vi.fn(async () => [dir("目录")]));
    fireEvent.compositionStart(input);
    fireEvent.change(input, { target: { value: "/work/目" } });
    fireEvent.keyDown(input, { key: "Enter", isComposing: true });
    fireEvent.keyDown(input, { key: "Tab", isComposing: true });
    await loadSuggestions();
    expect(listDirectory).not.toHaveBeenCalled();
    expect(onSubmit).not.toHaveBeenCalled();
    fireEvent.change(input, { target: { value: "/work/目" } });
    fireEvent.compositionEnd(input);
    await loadSuggestions();
    expect(listDirectory).toHaveBeenCalledWith("/work/");
    expect(input).toHaveFocus();
  });

  it("does not intercept Shift+Tab or modified Tab", async () => {
    const { input } = mount();
    fireEvent.change(input, { target: { value: "/work/Doc" } });
    await loadSuggestions();
    expect(fireEvent.keyDown(input, { key: "Tab", shiftKey: true })).toBe(true);
    expect(fireEvent.keyDown(input, { key: "Tab", ctrlKey: true })).toBe(true);
    expect(input).toHaveValue("/work/Doc");
  });

  it("submits once even when Enter also causes blur", () => {
    const { input, onSubmit } = mount();
    fireEvent.change(input, { target: { value: "/manual" } });
    fireEvent.keyDown(input, { key: "Enter" });
    fireEvent.blur(input);
    expect(onSubmit).toHaveBeenCalledExactlyOnceWith("/manual");
  });
});

describe("Windows breadcrumb navigation", () => {
  it("recognizes forward-slash drive paths and preserves UNC segment roots", () => {
    const onNavigate = vi.fn();
    const { rerender } = render(<PathBreadcrumb path="C:/Users/me" onNavigate={onNavigate} />);
    fireEvent.click(screen.getByText("Users"));
    expect(onNavigate).toHaveBeenLastCalledWith("C:\\Users");
    rerender(<PathBreadcrumb path="\\\\server\\share\\docs" onNavigate={onNavigate} />);
    fireEvent.click(screen.getByText("share"));
    expect(onNavigate).toHaveBeenLastCalledWith("\\\\server\\share");
  });
});
