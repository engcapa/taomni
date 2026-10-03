import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ChmodDialog, __testing } from "./ChmodDialog";
import type { FileEntry } from "../../lib/sftp";

const { modeToOctal, modeToSymbolic, parseOctalInput } = __testing;

function file(name: string, mode: number, fileType: FileEntry["fileType"] = "file"): FileEntry {
  return {
    name,
    path: `/work/${name}`,
    size: 0,
    mtime: 0,
    mode,
    fileType,
    isHidden: false,
  };
}

afterEach(() => cleanup());

describe("ChmodDialog helpers", () => {
  it("formats octal", () => {
    expect(modeToOctal(0o644)).toBe("644");
    expect(modeToOctal(0o7)).toBe("007");
  });
  it("formats symbolic", () => {
    expect(modeToSymbolic(0o644)).toBe("rw-r--r--");
    expect(modeToSymbolic(0o755)).toBe("rwxr-xr-x");
    expect(modeToSymbolic(0o000)).toBe("---------");
  });
  it("parses octal input", () => {
    expect(parseOctalInput("755")).toBe(0o755);
    expect(parseOctalInput(" 0644 ")).toBe(0o644);
    expect(parseOctalInput("9")).toBeNull();
    expect(parseOctalInput("")).toBeNull();
    expect(parseOctalInput("abc")).toBeNull();
  });
});

describe("ChmodDialog UI", () => {
  it("renders a 3x3 checkbox grid initialised from the current mode", () => {
    render(
      <ChmodDialog entries={[file("notes.txt", 0o644)]} onCancel={vi.fn()} onApply={vi.fn()} />,
    );
    // 9 permission checkboxes (no recursive checkbox for files).
    const checkboxes = screen.getAllByRole("checkbox");
    expect(checkboxes).toHaveLength(9);
    // 0o644 -> owner rw, group r, other r
    expect((screen.getByLabelText("Owner Read") as HTMLInputElement).checked).toBe(true);
    expect((screen.getByLabelText("Owner Write") as HTMLInputElement).checked).toBe(true);
    expect((screen.getByLabelText("Owner Execute") as HTMLInputElement).checked).toBe(false);
    expect((screen.getByLabelText("Group Read") as HTMLInputElement).checked).toBe(true);
    expect((screen.getByLabelText("Group Write") as HTMLInputElement).checked).toBe(false);
    expect((screen.getByLabelText("Other Read") as HTMLInputElement).checked).toBe(true);
    // Symbolic display
    expect(screen.getByText("rw-r--r--")).toBeInTheDocument();
    // Octal input value
    expect((screen.getByLabelText(/Octal/i) as HTMLInputElement).value).toBe("644");
  });

  it("toggling a checkbox updates the octal+symbolic display", async () => {
    const user = userEvent.setup();
    render(
      <ChmodDialog entries={[file("notes.txt", 0o644)]} onCancel={vi.fn()} onApply={vi.fn()} />,
    );
    await user.click(screen.getByLabelText("Owner Execute"));
    expect((screen.getByLabelText(/Octal/i) as HTMLInputElement).value).toBe("744");
    expect(screen.getByText("rwxr--r--")).toBeInTheDocument();
  });

  it("typing a valid octal updates the checkboxes", async () => {
    const user = userEvent.setup();
    render(
      <ChmodDialog entries={[file("notes.txt", 0o644)]} onCancel={vi.fn()} onApply={vi.fn()} />,
    );
    const octal = screen.getByLabelText(/Octal/i) as HTMLInputElement;
    await user.clear(octal);
    await user.type(octal, "755");
    expect((screen.getByLabelText("Group Execute") as HTMLInputElement).checked).toBe(true);
    expect((screen.getByLabelText("Other Execute") as HTMLInputElement).checked).toBe(true);
  });

  it("shows an Apply-recursively checkbox only when a directory is in the selection", () => {
    const { unmount } = render(
      <ChmodDialog entries={[file("notes.txt", 0o644)]} onCancel={vi.fn()} onApply={vi.fn()} />,
    );
    expect(screen.queryByLabelText(/Apply recursively/i)).not.toBeInTheDocument();
    unmount();

    render(
      <ChmodDialog
        entries={[file("subdir", 0o755, "dir")]}
        onCancel={vi.fn()}
        onApply={vi.fn()}
      />,
    );
    expect(screen.getByLabelText(/Apply recursively/i)).toBeInTheDocument();
  });

  it("calls onApply with the chosen mode and recursive flag", async () => {
    const user = userEvent.setup();
    const onApply = vi.fn();
    render(
      <ChmodDialog
        entries={[file("subdir", 0o755, "dir")]}
        onCancel={vi.fn()}
        onApply={onApply}
      />,
    );
    await user.click(screen.getByLabelText("Other Write"));
    await user.click(screen.getByLabelText(/Apply recursively/i));
    await user.click(screen.getByRole("button", { name: "Apply" }));
    expect(onApply).toHaveBeenCalledTimes(1);
    expect(onApply.mock.calls[0][0]).toBe(0o757);
    expect(onApply.mock.calls[0][1]).toBe(true);
  });

  it("shows a multi-item summary when several entries are passed", () => {
    render(
      <ChmodDialog
        entries={[file("a.txt", 0o644), file("b.txt", 0o644), file("c.txt", 0o600)]}
        onCancel={vi.fn()}
        onApply={vi.fn()}
      />,
    );
    expect(screen.getByText("3 items")).toBeInTheDocument();
  });

  it("Cancel calls onCancel and does not apply", async () => {
    const user = userEvent.setup();
    const onCancel = vi.fn();
    const onApply = vi.fn();
    render(
      <ChmodDialog entries={[file("notes.txt", 0o644)]} onCancel={onCancel} onApply={onApply} />,
    );
    await user.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onCancel).toHaveBeenCalledTimes(1);
    expect(onApply).not.toHaveBeenCalled();
  });
});
