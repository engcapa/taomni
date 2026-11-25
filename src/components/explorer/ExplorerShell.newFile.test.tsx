import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { editableFileExtensions, editableFileNames } from "../../lib/openFile/classifyFile";
import { defaultEntries, file, filesystem, installShellHarness, mountShell, native, row, rows, selection } from "./tests/explorerShellHarness";

installShellHarness();

async function openNewFile() {
  fireEvent.click(screen.getByTestId("explorer-cmd-new"));
  fireEvent.click(screen.getByTestId("explorer-new-typed-file"));
  return screen.getByTestId("explorer-new-file-dialog");
}

describe("Explorer creates files supported by the existing editors", () => {
  it.each(["md", "html", "svg", "json", "yaml", "xml", "csv", "ts", "py", "env", "name:dockerfile"])("creates %s, selects it for renaming and routes double-click through openFile", async (type) => {
    await mountShell();
    const dialog = await openNewFile();
    fireEvent.change(within(dialog).getByTestId("explorer-new-file-type"), { target: { value: type } });
    const name = (screen.getByTestId("explorer-new-file-name") as HTMLInputElement).value;
    fireEvent.click(screen.getByTestId("explorer-new-file-create"));
    await waitFor(() => expect(rows()).toContain(name));
    expect(native.localCreateEntry).toHaveBeenCalledWith("/fixture", name, false);
    expect(selection()).toEqual([`/fixture/${name}`]);
    expect(screen.queryByTestId("explorer-new-file-dialog")).toBeNull();
    fireEvent.keyDown(screen.getByTestId("explorer-rename-input"), { key: "Enter" });
    fireEvent.doubleClick(row(name));
    await waitFor(() => expect(native.openFile).toHaveBeenCalledWith({ path: `/fixture/${name}` }, expect.objectContaining({ context: "explorer" })));
  });

  it("lists every recognized editable extension/name and excludes preview-only types", async () => {
    await mountShell();
    const dialog = await openNewFile();
    const options = [...within(dialog).getByTestId("explorer-new-file-type").querySelectorAll("option")].map((item) => item.value);
    expect(new Set(options)).toEqual(new Set([...editableFileExtensions, ...editableFileNames.map((name) => `name:${name}`)]));
    for (const unsupported of ["pdf", "png", "jpg", "bin"]) expect(options).not.toContain(unsupported);
  });

  it("suggests a distinct numbered name for the selected extension, including case collisions", async () => {
    filesystem.set("/fixture", [...defaultEntries(), file("NEW FILE.md"), file("New file (2).md")]);
    await mountShell();
    await openNewFile();
    expect(screen.getByTestId("explorer-new-file-name")).toHaveValue("New file (3).md");
    fireEvent.click(screen.getByTestId("explorer-new-file-create"));
    await waitFor(() => expect(rows()).toContain("New file (3).md"));
    expect(rows()).toContain("NEW FILE.md");
    expect(rows()).toContain("New file (2).md");
  });

  it("opens from the empty-area context menu and cancels without creating or opening a file", async () => {
    const { list } = await mountShell();
    fireEvent.contextMenu(list);
    fireEvent.click(screen.getByTestId("explorer-context-new-typed-file"));
    fireEvent.click(screen.getByTestId("explorer-new-file-cancel"));
    expect(screen.queryByTestId("explorer-new-file-dialog")).toBeNull();
    await waitFor(() => expect(screen.getByTestId("explorer-cmd-new")).toHaveFocus());
    await openNewFile();
    fireEvent.keyDown(screen.getByTestId("explorer-new-file-name"), { key: "Escape" });
    expect(screen.queryByTestId("explorer-new-file-dialog")).toBeNull();
    expect(native.localCreateEntry).not.toHaveBeenCalled();
    expect(native.openFile).not.toHaveBeenCalled();
  });

  it("keeps dialog keyboard focus contained and does not close during IME composition", async () => {
    await mountShell();
    await openNewFile();
    const type = screen.getByTestId("explorer-new-file-type");
    type.focus();
    fireEvent.keyDown(type, { key: "Tab", shiftKey: true });
    expect(screen.getByTestId("explorer-new-file-create")).toHaveFocus();
    fireEvent.keyDown(screen.getByTestId("explorer-new-file-create"), { key: "Tab" });
    expect(type).toHaveFocus();
    fireEvent.keyDown(type, { key: "Escape", isComposing: true });
    expect(screen.getByTestId("explorer-new-file-dialog")).toBeInTheDocument();
    fireEvent.keyDown(type, { key: "Escape" });
    expect(screen.queryByTestId("explorer-new-file-dialog")).toBeNull();
    await waitFor(() => expect(screen.getByTestId("explorer-cmd-new")).toHaveFocus());
  });

  it("validates leaf/editable names and keeps a failed creation retryable without changing selection", async () => {
    await mountShell();
    fireEvent.click(row("alpha.txt"));
    await openNewFile();
    for (const name of ["", "..", "../outside.md", "folder\\outside.md", "image.png", "report.pdf"]) {
      fireEvent.change(screen.getByTestId("explorer-new-file-name"), { target: { value: name } });
      fireEvent.click(screen.getByTestId("explorer-new-file-create"));
      expect(screen.getByTestId("explorer-new-file-error")).not.toBeEmptyDOMElement();
      expect(native.localCreateEntry).not.toHaveBeenCalled();
    }
    fireEvent.change(screen.getByTestId("explorer-new-file-name"), { target: { value: "alpha.txt" } });
    fireEvent.click(screen.getByTestId("explorer-new-file-create"));
    await waitFor(() => expect(screen.getByTestId("explorer-new-file-error")).toHaveTextContent("already exists"));
    expect(native.localCreateEntry).not.toHaveBeenCalled();
    expect(selection()).toEqual(["/fixture/alpha.txt"]);
    fireEvent.change(screen.getByTestId("explorer-new-file-name"), { target: { value: "retry.md" } });
    native.localCreateEntry.mockRejectedValueOnce(new Error("Permission denied"));
    fireEvent.click(screen.getByTestId("explorer-new-file-create"));
    await waitFor(() => expect(screen.getByTestId("explorer-new-file-error")).toHaveTextContent("Permission denied"));
    expect(selection()).toEqual(["/fixture/alpha.txt"]);
    fireEvent.click(screen.getByTestId("explorer-new-file-create"));
    await waitFor(() => expect(rows()).toContain("retry.md"));
    expect(screen.queryByTestId("explorer-new-file-dialog")).toBeNull();
  });
});
