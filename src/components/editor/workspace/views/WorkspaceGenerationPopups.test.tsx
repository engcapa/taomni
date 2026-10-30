import { StrictMode } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { WorkspaceGenerationPopups, type WorkspaceGenerationPopupsProps } from "./WorkspaceGenerationPopups";

const settingsRender = vi.hoisted(() => vi.fn());
vi.mock("../FileTemplateSettingsDialog", async (original) => {
  const actual = await original<typeof import("../FileTemplateSettingsDialog")>();
  return {
    ...actual,
    FileTemplateSettingsDialog: (props: import("../FileTemplateSettingsDialog").FileTemplateSettingsDialogProps) => {
      settingsRender(props);
      return <actual.FileTemplateSettingsDialog {...props} />;
    },
  };
});

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  localStorage.clear();
});

function closedProps(): WorkspaceGenerationPopupsProps {
  return {
    newJavaClassDialogState: null, setNewJavaClassDialogState: vi.fn(),
    createJavaClassFromPlan: vi.fn(async () => true),
    fileTemplateSettingsOpen: false, setFileTemplateSettingsOpen: vi.fn(),
    autoImportSettingsOpen: false, setAutoImportSettingsOpen: vi.fn(),
    autoImportCandidatePrompt: null, workspaceUndoConfirmOpen: false,
    workspaceEditHistoryState: { undoLabel: null }, undoConfirmTriggerRef: { current: null },
    closeWorkspaceUndoConfirmation: vi.fn(), setWorkspaceUndoConfirmOpen: vi.fn(),
    undoWorkspaceEdit: vi.fn(async () => {}),
    refactoring: { extractNamingPrompt: null, resolveExtractNamingPrompt: vi.fn(), handleExtractNamingTab: vi.fn() },
  } as unknown as WorkspaceGenerationPopupsProps;
}

describe("generation popup lifecycle", () => {
  it("keeps closed template settings out of unrelated editor publications", () => {
    const initial = closedProps();
    const view = render(<StrictMode><WorkspaceGenerationPopups {...initial} /></StrictMode>);
    settingsRender.mockClear();
    view.rerender(<StrictMode><WorkspaceGenerationPopups {...closedProps()} /></StrictMode>);
    expect(settingsRender).not.toHaveBeenCalled();
    expect(screen.queryByRole("dialog")).toBeNull();
  });

  it("reopens template settings with persisted text and the latest close callback", () => {
    const initial = closedProps();
    const view = render(<WorkspaceGenerationPopups {...initial} />);
    view.rerender(<WorkspaceGenerationPopups {...initial} fileTemplateSettingsOpen />);
    const text = "public class ${NAME} { /* saved template */ }";
    fireEvent.change(screen.getByTestId("file-template-editor-textarea"), { target: { value: text } });
    fireEvent.click(screen.getByTestId("file-template-save-button"));
    view.rerender(<WorkspaceGenerationPopups {...initial} />);
    expect(screen.queryByTestId("file-template-settings-dialog")).toBeNull();
    const latest = closedProps();
    view.rerender(<WorkspaceGenerationPopups {...latest} />);
    view.rerender(<WorkspaceGenerationPopups {...latest} fileTemplateSettingsOpen />);
    expect(screen.getByTestId("file-template-editor-textarea")).toHaveValue(text);
    fireEvent.click(screen.getByTestId("file-template-close-button"));
    expect(latest.setFileTemplateSettingsOpen).toHaveBeenCalledWith(false);
    expect(initial.setFileTemplateSettingsOpen).not.toHaveBeenCalled();
  });

  it("opens auto-import settings after a closed owner change", () => {
    const initial = closedProps();
    const view = render(<WorkspaceGenerationPopups {...initial} />);
    const latest = closedProps();
    view.rerender(<WorkspaceGenerationPopups {...latest} />);
    view.rerender(<WorkspaceGenerationPopups {...latest} autoImportSettingsOpen />);
    fireEvent.keyDown(screen.getByTestId("auto-import-settings-dialog"), { key: "Escape" });
    expect(latest.setAutoImportSettingsOpen).toHaveBeenCalledWith(false);
    view.rerender(<WorkspaceGenerationPopups {...latest} />);
    expect(screen.queryByTestId("auto-import-settings-dialog")).toBeNull();
  });

  it("keeps current undo ownership, label and focus return across closing and reopening", async () => {
    const initial = closedProps();
    const tree = (props: WorkspaceGenerationPopupsProps) => <><button>Editor invoker</button><WorkspaceGenerationPopups {...props} /></>;
    const view = render(tree(initial));
    const invoker = screen.getByText("Editor invoker");
    const latest = { ...closedProps(), undoConfirmTriggerRef: { current: invoker } };
    latest.workspaceEditHistoryState = { ...latest.workspaceEditHistoryState, undoLabel: "Latest edit" };
    view.rerender(tree(latest));
    view.rerender(tree({ ...latest, workspaceUndoConfirmOpen: true }));
    expect(screen.getByText("Undo Latest edit?")).toBeInTheDocument();
    fireEvent.click(screen.getByTestId("code-workspace-undo-confirm-ok"));
    expect(latest.undoWorkspaceEdit).toHaveBeenCalledOnce();
    expect(initial.undoWorkspaceEdit).not.toHaveBeenCalled();
    view.rerender(tree(latest));
    await waitFor(() => expect(invoker).toHaveFocus());
    view.rerender(tree({ ...latest, workspaceUndoConfirmOpen: true }));
    fireEvent.keyDown(screen.getByTestId("code-workspace-undo-confirm"), { key: "Escape" });
    expect(latest.closeWorkspaceUndoConfirmation).toHaveBeenCalledOnce();
  });

  it("renders a late import candidate and extract prompt with their current callbacks", () => {
    const initial = closedProps();
    const view = render(<WorkspaceGenerationPopups {...initial} />);
    const candidate = { symbolName: "List", fullyQualifiedName: "java.util.List", sourcePackage: "java.util", priority: 1, origin: "provider" as const };
    const onSelect = vi.fn();
    view.rerender(<WorkspaceGenerationPopups {...initial} autoImportCandidatePrompt={{ candidates: [candidate], onSelect, onClose: vi.fn() }} />);
    fireEvent.click(screen.getByTestId("auto-import-candidate-submit"));
    expect(onSelect).toHaveBeenCalledWith(candidate);
    view.rerender(<WorkspaceGenerationPopups {...initial} />);
    expect(screen.queryByTestId("auto-import-candidate-dialog")).toBeNull();
    const refactoring = { ...initial.refactoring, extractNamingPrompt: { sessionId: "latest", resolve: vi.fn(), title: "Extract current method", label: "Name", initialValue: "currentMethod", confirmLabel: "Extract" } };
    view.rerender(<WorkspaceGenerationPopups {...initial} refactoring={refactoring} />);
    expect(screen.getByDisplayValue("currentMethod")).toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "Extract" }));
    expect(refactoring.resolveExtractNamingPrompt).toHaveBeenCalledWith("currentMethod");
  });

  it("opens Java creation after closed updates and follows live project facts", async () => {
    const initial = closedProps();
    const view = render(<WorkspaceGenerationPopups {...initial} />);
    const latest = closedProps();
    view.rerender(<WorkspaceGenerationPopups {...latest} />);
    const state = {
      open: true, targetDirectory: "/project/src/demo", root: { id: "project", path: "/project", name: "project", kind: "folder" },
      dirRelPath: "src/demo", sourceRoots: ["/project/src"], existingFiles: [],
      projectFactsStatus: "loading", projectFactsGeneration: 1, projectFactsFingerprint: null,
    } as NonNullable<WorkspaceGenerationPopupsProps["newJavaClassDialogState"]>;
    view.rerender(<WorkspaceGenerationPopups {...latest} newJavaClassDialogState={state} />);
    fireEvent.change(screen.getByTestId("new-java-class-name-input"), { target: { value: "Current" } });
    expect(screen.getByTestId("new-java-class-submit")).toBeDisabled();
    view.rerender(<WorkspaceGenerationPopups {...latest} newJavaClassDialogState={{ ...state, projectFactsStatus: "ready" }} />);
    expect(screen.getByTestId("new-java-class-package")).toHaveTextContent("demo");
    fireEvent.click(screen.getByTestId("new-java-class-submit"));
    await waitFor(() => expect(latest.createJavaClassFromPlan).toHaveBeenCalledOnce());
    expect(initial.createJavaClassFromPlan).not.toHaveBeenCalled();
    expect(latest.setNewJavaClassDialogState).toHaveBeenCalledWith(null);
  });
});
