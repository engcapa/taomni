import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FileLifecycleDialogs, type NotepadLifecycleModal } from "./FileLifecycleDialogs";

const mocks = vi.hoisted(() => ({
  selectSaveFilePath: vi.fn(async (): Promise<string | null> => null),
}));

vi.mock("../../../lib/ipc/files", () => ({
  selectSaveFilePath: mocks.selectSaveFilePath,
}));

type SaveAsModal = Extract<NotepadLifecycleModal, { kind: "saveAs" }>;

function saveAsModal(overrides: Partial<SaveAsModal> = {}): SaveAsModal {
  return {
    kind: "saveAs",
    defaultPath: "C:\\Users\\qa\\新建 1.txt",
    initialPath: "C:\\Users\\qa\\新建 1.txt",
    defaultDir: "C:\\Users\\qa",
    ...overrides,
  };
}

function renderDialog(modal: NotepadLifecycleModal, handlers: {
  onClose?: () => void;
  onSaveAs?: (path: string, overwrite: boolean, copy?: boolean) => Promise<void>;
} = {}) {
  // eslint-disable-next-line @typescript-eslint/no-empty-function
  const props = {
    modal,
    onClose: handlers.onClose ?? vi.fn(),
    onSaveAs: handlers.onSaveAs ?? vi.fn(async () => undefined),
    onRename: vi.fn(async () => undefined),
    onTrash: vi.fn(async () => undefined),
    onElevatedSave: vi.fn(async () => undefined),
    onOpenFolderFiles: vi.fn(async () => undefined),
  };
  return { ...render(<FileLifecycleDialogs {...props} />), props };
}

afterEach(() => {
  cleanup();
  mocks.selectSaveFilePath.mockClear();
  mocks.selectSaveFilePath.mockImplementation(async () => null);
});

describe("FileLifecycleDialogs Save As (U2)", () => {
  it("prefills the absolute default path and renders the themed np-modal surface", () => {
    renderDialog(saveAsModal());
    expect(screen.getByTestId("notepad-save-as-dialog")).toBeInTheDocument();
    expect(screen.getByTestId("notepad-save-as-input")).toHaveValue("C:\\Users\\qa\\新建 1.txt");
    // AC-1: the dialog is the shared .np-modal surface whose background now uses
    // the defined --taomni-panel-bg token (token regression is covered by
    // notepadThemeTokens.test.ts; computed colors by browser QA).
    expect(document.querySelector(".np-modal")).not.toBeNull();
  });

  it("opens the browse picker with the file name and the resolved default directory", async () => {
    mocks.selectSaveFilePath.mockResolvedValueOnce("C:\\Users\\qa\\chosen.txt");
    const { props } = renderDialog(saveAsModal());
    fireEvent.click(screen.getByTestId("notepad-save-as-browse"));
    await waitFor(() =>
      expect(mocks.selectSaveFilePath).toHaveBeenCalledWith("新建 1.txt", "C:\\Users\\qa\\"),
    );
    await waitFor(() => expect(screen.getByTestId("notepad-save-as-input")).toHaveValue("C:\\Users\\qa\\chosen.txt"));
    expect(props.onSaveAs).not.toHaveBeenCalled();
  });

  it("submits the edited absolute path through onSaveAs and closes", async () => {
    const { props } = renderDialog(saveAsModal());
    fireEvent.change(screen.getByTestId("notepad-save-as-input"), {
      target: { value: "D:\\work\\notes.txt" },
    });
    fireEvent.click(screen.getByTestId("notepad-save-as-confirm"));
    // A regular Save As modal has no copy flag, so the third argument stays undefined.
    await waitFor(() => expect(props.onSaveAs).toHaveBeenCalledWith("D:\\work\\notes.txt", false, undefined));
    await waitFor(() => expect(props.onClose).toHaveBeenCalled());
  });

  it("passes the copy flag for Save a Copy and works for a document that has a path", async () => {
    const { props } = renderDialog(saveAsModal({
      copy: true,
      defaultPath: "/home/qa/report.txt",
      initialPath: "/home/qa/report.txt",
      defaultDir: "/home/qa",
    }));
    expect(screen.getByTestId("notepad-save-as-input")).toHaveValue("/home/qa/report.txt");
    fireEvent.click(screen.getByTestId("notepad-save-as-confirm"));
    await waitFor(() => expect(props.onSaveAs).toHaveBeenCalledWith("/home/qa/report.txt", false, true));
  });
});


