import { installShellHarness, mountShell, row, rows, selection, native, filesystem, file, TAB, pointer, setWidth } from "./tests/explorerShellHarness";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { useSftpStore } from "../../stores/sftpStore";
import { getExplorerPreferences, setExplorerPreferences } from "./explorerPreferences";

installShellHarness();

describe("Explorer shared FilePanel selection", () => {
  it("renders one authoritative local pane and applies click, Ctrl-click, Shift-range and select-all", async () => {
    const { root, list } = await mountShell();
    expect(rows(root)).toEqual(["folder", "alpha.txt", "beta.md", "gamma.csv"]);
    fireEvent.click(row("alpha.txt"));
    expect(selection()).toEqual(["/fixture/alpha.txt"]);
    expect(screen.getByTestId("explorer-status")).toHaveTextContent("1 selected · 20 B");
    fireEvent.click(row("gamma.csv"), { ctrlKey: true });
    expect(selection()).toEqual(["/fixture/alpha.txt", "/fixture/gamma.csv"]);
    fireEvent.click(row("beta.md"), { shiftKey: true });
    expect(selection()).toEqual(["/fixture/beta.md", "/fixture/gamma.csv"]);
    fireEvent.keyDown(list, { key: "a", ctrlKey: true });
    expect(selection()).toEqual(["/fixture/folder", "/fixture/alpha.txt", "/fixture/beta.md", "/fixture/gamma.csv"]);
    expect(Object.keys(useSftpStore.getState().sessions)).toEqual([TAB]);
  });

  it("retains the list DOM and keyboard anchor across selection, filtering and preference updates", async () => {
    const { list } = await mountShell();
    fireEvent.click(row("alpha.txt"));
    fireEvent.keyDown(list, { key: "ArrowDown", shiftKey: true });
    expect(selection()).toEqual(["/fixture/alpha.txt", "/fixture/beta.md"]);
    expect(screen.getByTestId("explorer-file-list")).toBe(list);
    act(() => setExplorerPreferences({ sortDir: "desc" }));
    expect(screen.getByTestId("explorer-file-list")).toBe(list);
    fireEvent.keyDown(list, { key: "Home" });
    expect(selection()).toEqual(["/fixture/folder"]);
    fireEvent.keyDown(list, { key: "End" });
    expect(selection()).toEqual(["/fixture/alpha.txt"]);
    expect(screen.getByTestId("explorer-file-list")).toBe(list);
  });

  it("rubber-selects only geometrically intersecting rows and preserves additive selection", async () => {
    const { list } = await mountShell();
    pointer(list, "pointerdown", { button: 0, clientX: 5, clientY: 1 });
    pointer(window, "pointermove", { buttons: 1, clientX: 150, clientY: 20 });
    expect(selection()).toEqual(["/fixture/folder"]);
    pointer(window, "pointerup", { button: 0, clientX: 150, clientY: 20 });
    expect(list.querySelector(".ex-rubber")).toBeNull();
    fireEvent.click(row("gamma.csv"));
    pointer(list, "pointerdown", { button: 0, ctrlKey: true, clientX: 5, clientY: 29 });
    pointer(window, "pointermove", { buttons: 1, ctrlKey: true, clientX: 150, clientY: 45 });
    expect(selection()).toEqual(["/fixture/gamma.csv", "/fixture/alpha.txt"]);
    pointer(window, "pointercancel", { clientX: 150, clientY: 45 });
    expect(list.querySelector(".ex-rubber")).toBeNull();
  });

  it("does not operate on filtered-out selection from toolbar or shell shortcuts", async () => {
    const { root } = await mountShell();
    fireEvent.click(row("alpha.txt"));
    fireEvent.change(screen.getByTestId("explorer-filter"), { target: { value: "beta" } });
    expect(rows()).toEqual(["beta.md"]);
    expect(screen.getByTestId("explorer-cmd-copy")).toBeDisabled();
    fireEvent.keyDown(root, { key: "c", ctrlKey: true });
    await act(async () => {});
    expect(native.explorerWriteClipboardFiles).not.toHaveBeenCalled();
    expect(screen.getByTestId("explorer-status")).not.toHaveTextContent("selected");
  });
});

describe("Explorer editing and shortcut ownership", () => {
  it("selects the basename for F2 rename, preserves the focused input after a collision and retries", async () => {
    const { list } = await mountShell();
    fireEvent.click(row("alpha.txt"));
    fireEvent.keyDown(list, { key: "F2" });
    const input = screen.getByTestId("explorer-rename-input") as HTMLInputElement;
    expect(input).toHaveFocus(); expect(input.selectionStart).toBe(0); expect(input.selectionEnd).toBe(5);
    fireEvent.change(input, { target: { value: "beta.md" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(await screen.findByTestId("explorer-toast")).toHaveTextContent("same name");
    expect(input).toHaveFocus(); expect(screen.getByTestId("explorer-rename-input")).toBe(input);
    fireEvent.change(input, { target: { value: "renamed.txt" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(screen.queryByTestId("explorer-rename-input")).toBeNull());
    expect(selection()).toEqual(["/fixture/renamed.txt"]);
    expect(rows()).toContain("renamed.txt");
    expect(native.localRenameEntry).toHaveBeenCalledTimes(2);
  });

  it("does not commit rename on composing Enter and Escape cancels without a blur commit", async () => {
    const { list } = await mountShell();
    fireEvent.click(row("alpha.txt")); fireEvent.keyDown(list, { key: "F2" });
    const input = screen.getByTestId("explorer-rename-input");
    fireEvent.change(input, { target: { value: "中文.txt" } });
    fireEvent.keyDown(input, { key: "Enter", isComposing: true });
    await act(async () => {});
    expect(native.localRenameEntry).not.toHaveBeenCalled();
    fireEvent.keyDown(input, { key: "Escape" });
    fireEvent.blur(input);
    expect(native.localRenameEntry).not.toHaveBeenCalled();
    expect(screen.queryByTestId("explorer-rename-input")).toBeNull();
  });

  it("editable fields and IME own ordinary editing keys while Ctrl+L deliberately focuses the address", async () => {
    const { root, list } = await mountShell();
    fireEvent.click(row("alpha.txt"));
    const filter = screen.getByTestId("explorer-filter");
    for (const key of ["c", "x", "v", "a"]) fireEvent.keyDown(filter, { key, ctrlKey: true });
    fireEvent.keyDown(filter, { key: "Delete" });
    fireEvent.keyDown(list, { key: "c", ctrlKey: true, isComposing: true });
    fireEvent.keyDown(list, { key: "ArrowDown", isComposing: true });
    expect(selection()).toEqual(["/fixture/alpha.txt"]);
    expect(native.explorerWriteClipboardFiles).not.toHaveBeenCalled();
    expect(native.localTrashEntries).not.toHaveBeenCalled();
    fireEvent.keyDown(filter, { key: "l", ctrlKey: true });
    expect(screen.getByTestId("explorer-address")).toHaveFocus();
    fireEvent.keyDown(root, { key: "Enter", altKey: true });
    expect(await screen.findByTestId("explorer-properties-dialog")).toBeVisible();
    expect(native.sftpOpenPath).not.toHaveBeenCalled();
  });

  it("uses Command for macOS copy/select-all without commandeering Control editing commands", async () => {
    native.platform = "macos";
    const { list } = await mountShell();
    fireEvent.click(row("alpha.txt"));
    fireEvent.keyDown(list, { key: "c", ctrlKey: true });
    expect(native.explorerWriteClipboardFiles).not.toHaveBeenCalled();
    fireEvent.keyDown(list, { key: "c", metaKey: true, shiftKey: true });
    expect(native.explorerWriteClipboardFiles).not.toHaveBeenCalled();
    fireEvent.keyDown(list, { key: "c", metaKey: true });
    await waitFor(() => expect(native.explorerWriteClipboardFiles).toHaveBeenCalledWith(["/fixture/alpha.txt"], false));
    fireEvent.keyDown(list, { key: "a", metaKey: true });
    expect(selection()).toHaveLength(4);
  });
});

describe("Explorer preferences and responsive preview", () => {
  it("shares hidden/sort/view preferences across independent tabs without remounting lists", async () => {
    const first = await mountShell();
    const second = await mountShell({ tabId: "second-shell" });
    fireEvent.click(within(first.root).getByTestId("explorer-cmd-view"));
    fireEvent.click(screen.getByTestId("explorer-view-hidden"));
    expect(rows(first.root)).toContain(".hidden.txt"); expect(rows(second.root)).toContain(".hidden.txt");
    expect(getExplorerPreferences().showHidden).toBe(true);
    fireEvent.click(within(first.root).getByTestId("explorer-column-size"));
    expect(rows(first.root)).toEqual(["folder", "alpha.txt", "beta.md", "gamma.csv", ".hidden.txt"]);
    fireEvent.click(within(first.root).getByTestId("explorer-column-size"));
    expect(rows(second.root)).toEqual(["folder", ".hidden.txt", "gamma.csv", "beta.md", "alpha.txt"]);
    expect(within(first.root).getByTestId("explorer-file-list")).toBe(first.list);
    fireEvent.click(within(first.root).getByTestId("explorer-cmd-view"));
    fireEvent.click(screen.getByTestId("explorer-view-icons"));
    expect(within(first.root).queryByTestId("explorer-column-name")).toBeNull();
    expect(row("alpha.txt", first.root)).toHaveClass("ex-tile");
    expect(row("alpha.txt", second.root)).toHaveClass("ex-tile");
    expect(within(second.root).getByTestId("explorer-file-list")).toBe(second.list);
  });

  it("auto-folds preview without losing preference and manually opens a narrow overlay", async () => {
    const { root } = await mountShell();
    expect(screen.getByTestId("explorer-preview")).toBeVisible();
    setWidth(700);
    expect(root).toHaveAttribute("data-preview-collapsed", "true");
    expect(screen.queryByTestId("explorer-preview")).toBeNull(); expect(getExplorerPreferences().preview).toBe(true);
    fireEvent.click(screen.getByTestId("explorer-cmd-preview"));
    expect(screen.getByTestId("explorer-preview").parentElement).toHaveClass("ex-preview-overlay");
    expect(screen.getByTestId("explorer-preview").parentElement).toHaveAttribute("data-position", "right");
    act(() => setExplorerPreferences({ previewPosition: "bottom" }));
    expect(screen.getByTestId("explorer-preview").parentElement).toHaveAttribute("data-position", "bottom");
    expect(root).toHaveAttribute("data-preview-collapsed", "false");
    fireEvent.keyDown(root, { key: "Escape" });
    expect(screen.queryByTestId("explorer-preview")).toBeNull(); expect(getExplorerPreferences().preview).toBe(true);
    setWidth(1200);
    expect(screen.getByTestId("explorer-preview")).toBeVisible();
    fireEvent.keyDown(root, { key: "p", altKey: true });
    expect(screen.queryByTestId("explorer-preview")).toBeNull(); expect(getExplorerPreferences().preview).toBe(false);
  });

  it("recognizes macOS Option+P by physical key code when the layout emits π", async () => {
    native.platform = "macos";
    const { root } = await mountShell();
    fireEvent.keyDown(root, { key: "π", code: "KeyP", altKey: true });
    expect(getExplorerPreferences().preview).toBe(false);
    expect(screen.queryByTestId("explorer-preview")).toBeNull();
  });

  it("virtualizes >=10,000 entries and selects an offscreen last row by keyboard", async () => {
    filesystem.set("/fixture", Array.from({ length: 10_000 }, (_, index) => file(`item-${String(index).padStart(5, "0")}.txt`)));
    const { root, list } = await mountShell();
    expect(root.querySelectorAll('[data-testid="explorer-file-row"]').length).toBeLessThan(40);
    expect(screen.getByTestId("explorer-status")).toHaveTextContent("10000 items");
    fireEvent.keyDown(list, { key: "End" });
    expect(selection()).toEqual(["/fixture/item-09999.txt"]);
    await waitFor(() => expect(rows(root)).toContain("item-09999.txt"));
    expect(root.querySelectorAll('[data-testid="explorer-file-row"]').length).toBeLessThan(40);
    fireEvent.change(screen.getByTestId("explorer-filter"), { target: { value: "item-0000" } });
    await waitFor(() => expect(rows(root)).toHaveLength(10));
    expect(list.scrollTop).toBe(0);
    expect(rows(root)[0]).toBe("item-00000.txt");
  });
});
