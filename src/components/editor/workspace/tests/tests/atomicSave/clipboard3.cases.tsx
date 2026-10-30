import { findEditorByTitle, findEditorPanes } from "../../editorReadiness";
import { EditorSelection } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { StrictMode } from "react";
import { expect, it, vi } from "vitest";
import { useAppStore } from "../../../../../../stores/appStore";
import { selectCodeWorkspaceUi, useCodeWorkspaceStore } from "../../../../../../stores/codeWorkspaceStore";
import type { CodeWorkspaceTabInfo } from "../../../../../../types";
import { CodeWorkspaceTab } from "../../../../CodeWorkspaceTab";
import { acquireClipboardStore, resetWorkspaceClipboardStores } from "../../../workspaceClipboardSession";
import type { WorkspaceCommandRegistration } from "../../../workspaceCommands";
import { hasBlockingDiskEffectResolution } from "../../../workspaceRecovery";
import { type registerSaveCasesFixture } from "../../save.cases";

export interface registeratomicSaveClipboard3CasesContext {
  workspaceTestHarness: registerSaveCasesFixture;
}

export function registeratomicSaveClipboard3Cases(caseContext: registeratomicSaveClipboard3CasesContext) {

  it("reports a verified zero-effect unknown failure and unblocks the retry after read-back", async () => {
    const path = "src/main.ts";
    const workspace: CodeWorkspaceTabInfo = {
      repoRoot: "/repo/app",
      workspaceId: "ws-save-unknown-none",
      workspaceInstanceId: "instance-save-unknown-none",
      name: "Save Unknown None",
      roots: [{ id: "app", name: "app", path: "/repo/app", kind: "git" }],
      looseFiles: [],
      initialFile: { kind: "root", rootId: "app", path },
    };
    caseContext.workspaceTestHarness.workspaceMocks.workspaceListDir.mockResolvedValue([caseContext.workspaceTestHarness.entry("src", "src", "dir")]);
    caseContext.workspaceTestHarness.workspaceMocks.workspaceReadFile.mockResolvedValue(caseContext.workspaceTestHarness.file(path, "initial\n"));
    caseContext.workspaceTestHarness.workspaceMocks.workspaceWriteFileEncoded.mockRejectedValue(Object.assign(
      new Error("atomic replace acknowledgement was lost"),
      {
        kind: "io",
        effect: "unknown",
        intentHash: "intended-new-hash",
        intentByteLength: 16,
        oldHash: `hash-${path}`,
      },
    ));
    // The read-back proves the old bytes are still on disk: nothing landed.
    caseContext.workspaceTestHarness.workspaceMocks.workspaceReadFileWithEncoding.mockResolvedValue(caseContext.workspaceTestHarness.file(path, "initial\n"));

    const rendered = caseContext.workspaceTestHarness.renderWorkspace(workspace);
    await findEditorByTitle(`app / ${path}`);
    const content = rendered.container.querySelector<HTMLElement>(".cm-content");
    expect(content).not.toBeNull();
    fireEvent.keyDown(content!, { key: "d", code: "KeyD", ctrlKey: true });
    await waitFor(() => expect(selectCodeWorkspaceUi(
      useCodeWorkspaceStore.getState(),
      "instance-save-unknown-none",
    ).openFiles[`root:app:${path}`]?.dirty).toBe(true));

    fireEvent.keyDown(window, { key: "s", code: "KeyS", ctrlKey: true });
    await waitFor(() => expect(useAppStore.getState().statusMessage).toContain("Save failed"));
    expect(caseContext.workspaceTestHarness.workspaceMocks.workspaceWriteFileEncoded).toHaveBeenCalledTimes(1);
    expect(caseContext.workspaceTestHarness.workspaceMocks.workspaceReadFileWithEncoding).toHaveBeenCalledWith(
      "/repo/app",
      path,
      "UTF-8",
    );

    const errorObservation = screen.getByTestId("code-workspace-save-observation");
    expect(errorObservation).toHaveAttribute("data-state", "error");
    expect(errorObservation).toHaveAttribute("data-result-kind", "failed");
    expect(errorObservation).toHaveAttribute("data-disk-effect", "none");
    expect(errorObservation).toHaveAttribute("data-dirty", "true");
    expect(errorObservation).not.toHaveAttribute("data-receipt-id");
    expect(errorObservation).not.toHaveAttribute("data-recovery-id");

    // Verified zero effect: no blocking ledger row, and the buffer keeps
    // the user's edits dirty for an ordinary retry.
    const fileState = selectCodeWorkspaceUi(
      useCodeWorkspaceStore.getState(),
      "instance-save-unknown-none",
    ).openFiles[`root:app:${path}`];
    expect(fileState?.dirty).toBe(true);
    expect(fileState?.text).toBe("initial\ninitial\n");
    expect(hasBlockingDiskEffectResolution(
      "instance-save-unknown-none",
      `/repo/app/${path}`,
    )).toBe(false);

    // The retry is unblocked: the next Ctrl+S invokes the writer again.
    fireEvent.keyDown(window, { key: "s", code: "KeyS", ctrlKey: true });
    await waitFor(() => expect(caseContext.workspaceTestHarness.workspaceMocks.workspaceWriteFileEncoded).toHaveBeenCalledTimes(2));
  });

  it("§8.27.2 BB1 passes root clipboard handle via WorkspaceClipboardSessionContext to CodeMirror split instances", async () => {
    const workspace: CodeWorkspaceTabInfo = {
      repoRoot: "/repo/app",
      workspaceId: "ws-clipboard-bb1",
      workspaceInstanceId: "instance-clipboard-bb1",
      name: "Clipboard Workspace",
      roots: [{ id: "app", name: "app", path: "/repo/app", kind: "folder" }],
      looseFiles: [],
      initialFile: { kind: "root", rootId: "app", path: "src/main.ts" },
    };
    caseContext.workspaceTestHarness.workspaceMocks.workspaceReadFile.mockImplementation(async (_root: string, path: string) => {
      if (path === "src/main.ts") return caseContext.workspaceTestHarness.file("src/main.ts", "content-in-main\n");
      return caseContext.workspaceTestHarness.file("src/util.ts", "content-in-util\n");
    });

    caseContext.workspaceTestHarness.renderWorkspace(workspace);
    await findEditorByTitle("app / src/main.ts");

    // Verify that the clipboard store was acquired and is active for this workspaceInstanceId
    const store = acquireClipboardStore("instance-clipboard-bb1");
    const snap = store.getSnapshot();
    expect(snap.consumerCount).toBeGreaterThanOrEqual(1);
    expect(snap.permissionGeneration).toBe(1);

    // Write to the workspace clipboard handle
    store.write({
      sourceViewId: null,
      plainText: "copied-across-split",
      rectangular: false,
      sourceEol: "lf",
    });

    expect(store.read()?.plainText).toBe("copied-across-split");
    store.release();
  });

  it("ED-CLIP-003: cross-split multi-caret copy in primary and paste in secondary with single undo (different files)", async () => {
    resetWorkspaceClipboardStores();
    const baselineConsumerCount = 0;
    const workspace: CodeWorkspaceTabInfo = {
      repoRoot: "/repo/app",
      workspaceId: "ws-clip-split-diff",
      workspaceInstanceId: "instance-clip-split-diff",
      name: "Different Files Split",
      roots: [{ id: "app", name: "app", path: "/repo/app", kind: "folder" }],
      looseFiles: [],
      initialFile: { kind: "root", rootId: "app", path: "src/main.ts" },
    };
    caseContext.workspaceTestHarness.workspaceMocks.workspaceReadFile.mockImplementation(async (_root: string, path: string) => (
      path === "src/util.ts" || path === "/repo/app/src/util.ts"
        ? caseContext.workspaceTestHarness.file("src/util.ts", "let a = 0;\nlet b = 0;\n")
        : caseContext.workspaceTestHarness.file("src/main.ts", "const x = 10;\nconst y = 20;\n")
    ));

    window.localStorage.setItem("taomni.codeWorkspace.layout.v1.instance-clip-split-diff", JSON.stringify({
      version: 1,
      splitOrientation: "vertical",
      activeEditorGroupId: "primary",
      editorGroups: {
        primary: {
          openOrder: ["root:app:src/main.ts"],
          activeKey: "root:app:src/main.ts",
          previewKey: null,
          pinnedKeys: [],
        },
        secondary: {
          openOrder: ["root:app:src/util.ts"],
          activeKey: "root:app:src/util.ts",
          previewKey: null,
          pinnedKeys: [],
        },
      },
    }));

    const registrationRef: { current: WorkspaceCommandRegistration | null; } = { current: null };
    const onCommandsChange = vi.fn((_tabId: string, next: WorkspaceCommandRegistration | null) => {
      registrationRef.current = next;
    });

    const { unmount } = caseContext.workspaceTestHarness.renderWorkspace(workspace, { onCommandsChange });
    await findEditorByTitle("app / src/main.ts");
    await findEditorByTitle("app / src/util.ts");

    const panes = await findEditorPanes();
    const primaryPane = panes.find((p) => p.getAttribute("data-editor-group-id") === "primary");
    const secondaryPane = panes.find((p) => p.getAttribute("data-editor-group-id") === "secondary");
    const primaryEditor = primaryPane?.querySelector<HTMLElement>(".cm-editor");
    const secondaryEditor = secondaryPane?.querySelector<HTMLElement>(".cm-editor");

    expect(primaryEditor).not.toBeNull();
    expect(secondaryEditor).not.toBeNull();
    const primaryView = EditorView.findFromDOM(primaryEditor!);
    const secondaryView = EditorView.findFromDOM(secondaryEditor!);
    expect(primaryView).not.toBeNull();
    expect(secondaryView).not.toBeNull();

    // Assert consumer lease count: both splits hold active leases with distinct tokens
    const store = acquireClipboardStore("instance-clip-split-diff");
    const snap = store.getSnapshot();
    expect(snap.consumerCount).toBe(2);
    expect(snap.consumers[0].token).not.toBe(snap.consumers[1].token);

    // Select 2 segments in primary view (src/main.ts)
    primaryView!.dispatch({
      selection: EditorSelection.create([
        EditorSelection.range(0, 13), // "const x = 10;"
        EditorSelection.range(14, 27), // "const y = 20;"
      ], 0),
    });

    // Focus primary pane and execute copy
    fireEvent.mouseDown(primaryPane!);
    await waitFor(() => expect(
      selectCodeWorkspaceUi(useCodeWorkspaceStore.getState(), "instance-clip-split-diff").activeEditorGroupId,
    ).toBe("primary"));
    await waitFor(() => expect(
      registrationRef.current?.items.find((item) => item.id === "workspace.editor.copy")?.enabled,
    ).toBe(true));

    await act(async () => {
      await registrationRef.current?.executeAction("workspace.editor.copy");
    });

    // Assert copied payload in workspace session
    const session = store.read();
    expect(session).not.toBeNull();
    expect(session?.segments).toEqual(["const x = 10;", "const y = 20;"]);
    expect(session?.plainText).toBe("const x = 10;\nconst y = 20;");

    // Place 2 carets in secondary view (src/util.ts)
    secondaryView!.dispatch({
      selection: EditorSelection.create([
        EditorSelection.cursor(0), // before "let a = 0;"
        EditorSelection.cursor(11), // before "let b = 0;"
      ], 0),
    });
    const destinationSelectionBeforePaste = secondaryView!.state.selection;
    expect(destinationSelectionBeforePaste.ranges.map((range) => range.head)).toEqual([0, 11]);

    // Focus secondary pane and execute paste
    fireEvent.mouseDown(secondaryPane!);
    await waitFor(() => expect(
      selectCodeWorkspaceUi(useCodeWorkspaceStore.getState(), "instance-clip-split-diff").activeEditorGroupId,
    ).toBe("secondary"));
    await waitFor(() => expect(
      registrationRef.current?.items.find((item) => item.id === "workspace.editor.paste")?.enabled,
    ).toBe(true));

    await act(async () => {
      await registrationRef.current?.executeAction("workspace.editor.paste");
    });

    // Assert target text in secondary view has distributed segments
    await waitFor(() => {
      expect(secondaryView!.state.doc.toString()).toBe("const x = 10;let a = 0;\nconst y = 20;let b = 0;\n");
      expect(secondaryView!.state.selection.ranges.map((range) => range.head)).toEqual([13, 37]);
      expect(primaryView!.state.doc.toString()).toBe("const x = 10;\nconst y = 20;\n");
    });

    // Single undo restores pre-paste state. Drive the production entry
    // (Ctrl+Z -> workspace.undo -> shared transaction owner): a shared
    // document has no local CodeMirror history() to undo.
    fireEvent.keyDown(secondaryPane!, { key: "z", ctrlKey: true });
    await waitFor(() => {
      expect(secondaryView!.state.doc.toString()).toBe("let a = 0;\nlet b = 0;\n");
      expect(secondaryView!.state.selection.eq(destinationSelectionBeforePaste, true)).toBe(true);
    });

    store.release();
    unmount();
    await new Promise((resolve) => setTimeout(resolve, 20));

    // After workspace unmount, consumer leases and slot are cleaned up
    const afterStore = acquireClipboardStore("instance-clip-split-diff");
    expect(afterStore.getSnapshot().consumerCount).toBe(baselineConsumerCount);
    expect(afterStore.read()).toBeNull();
    afterStore.release();
    resetWorkspaceClipboardStores();
  });

  it("ED-CLIP-004: projects typed copy/paste outcome, OS effect and fallback into the clipboard observation seam", async () => {
    resetWorkspaceClipboardStores();
    const workspace: CodeWorkspaceTabInfo = {
      repoRoot: "/repo/app",
      workspaceId: "ws-clip-observe",
      workspaceInstanceId: "instance-clip-observe",
      name: "Clipboard Observation",
      roots: [{ id: "app", name: "app", path: "/repo/app", kind: "folder" }],
      looseFiles: [],
      initialFile: { kind: "root", rootId: "app", path: "src/main.ts" },
    };
    caseContext.workspaceTestHarness.workspaceMocks.workspaceReadFile.mockImplementation(async () => (
      caseContext.workspaceTestHarness.file("src/main.ts", "const x = 10;\nconst y = 20;\n")
    ));

    const registrationRef: { current: WorkspaceCommandRegistration | null; } = { current: null };
    const onCommandsChange = vi.fn((_tabId: string, next: WorkspaceCommandRegistration | null) => {
      registrationRef.current = next;
    });

    caseContext.workspaceTestHarness.renderWorkspace(workspace, { onCommandsChange });
    await findEditorByTitle("app / src/main.ts");

    const observation = screen.getByTestId("code-workspace-clipboard-observation");
    // Live-region semantics exist before any clipboard operation ran.
    expect(observation.getAttribute("role")).toBe("status");
    expect(observation.getAttribute("aria-live")).toBe("polite");
    expect(observation.getAttribute("aria-label")).toBe("Clipboard status");
    expect(observation.getAttribute("data-outcome")).toBeNull();

    const pane = screen.getAllByTestId("code-workspace-editor-pane")[0];
    const view = EditorView.findFromDOM(pane.querySelector<HTMLElement>(".cm-editor")!);
    expect(view).not.toBeNull();

    // Two carets so the seam reports the real multi-caret shape.
    view!.dispatch({
      selection: EditorSelection.create([
        EditorSelection.range(0, 13),
        EditorSelection.range(14, 27),
      ], 0),
    });
    fireEvent.mouseDown(pane);
    await waitFor(() => expect(
      registrationRef.current?.items.find((item) => item.id === "workspace.editor.copy")?.enabled,
    ).toBe(true));
    await act(async () => {
      await registrationRef.current?.executeAction("workspace.editor.copy");
    });

    await waitFor(() => {
      expect(observation.getAttribute("data-operation")).toBe("copy");
      expect(observation.getAttribute("data-outcome")).toBe("success");
      expect(observation.getAttribute("data-system-effect")).toBe("performed");
    });
    expect(observation.getAttribute("data-segment-count")).toBe("2");
    expect(observation.getAttribute("data-caret-count")).toBe("2");
    expect(observation.getAttribute("data-payload-length")).toBe(
      String("const x = 10;\nconst y = 20;".length),
    );
    expect(observation.getAttribute("data-workspace-fallback")).toBe("false");
    // Metadata only: the copied text never reaches the DOM seam.
    expect(observation.outerHTML).not.toContain("const x = 10;");
    expect(observation.textContent).toContain("system clipboard effect performed");

    // Real OS read failure: the workspace slot answers and the seam reports
    // unavailable + unknown effect + a visible fallback, never success.
    // mockImplementationOnce, restored below: a leftover queued *Once value
    // would otherwise leak into a later test's clipboard read.
    const defaultNativeReadTextResult = caseContext.workspaceTestHarness.clipboardMocks.readNativeTextResult.getMockImplementation();
    caseContext.workspaceTestHarness.runtimeState.tauri = true;
    caseContext.workspaceTestHarness.clipboardMocks.readNativeTextResult.mockImplementationOnce(async () => ({ ok: false, text: "" }));
    caseContext.workspaceTestHarness.clipboardMocks.readTextResult.mockClear();
    view!.dispatch({ selection: EditorSelection.single(0) });
    await waitFor(() => expect(
      registrationRef.current?.items.find((item) => item.id === "workspace.editor.paste")?.enabled,
    ).toBe(true));
    await act(async () => {
      await registrationRef.current?.executeAction("workspace.editor.paste");
    });

    await waitFor(() => {
      expect(observation.getAttribute("data-operation")).toBe("paste");
      expect(observation.getAttribute("data-outcome")).toBe("unavailable");
    });
    expect(observation.getAttribute("data-system-effect")).toBe("unknown");
    expect(observation.getAttribute("data-workspace-fallback")).toBe("true");
    expect(observation.textContent).toContain("workspace clipboard slot");
    expect(caseContext.workspaceTestHarness.clipboardMocks.readNativeTextResult).toHaveBeenCalledTimes(1);
    expect(caseContext.workspaceTestHarness.clipboardMocks.readTextResult).not.toHaveBeenCalled();
    // The fallback really inserted the payload rather than reporting success.
    expect(view!.state.doc.toString()).toContain("const x = 10;\nconst y = 20;const x = 10;");

    // Drain any unconsumed one-shot and restore the shared mock so this test
    // cannot alter a later test's clipboard behaviour.
    caseContext.workspaceTestHarness.clipboardMocks.readNativeTextResult.mockReset();
    if (defaultNativeReadTextResult) {
      caseContext.workspaceTestHarness.clipboardMocks.readNativeTextResult.mockImplementation(defaultNativeReadTextResult);
    }
    resetWorkspaceClipboardStores();
  });

  it("ED-CLIP-003: cross-split copy/paste with same-file dual split under StrictMode", async () => {
    resetWorkspaceClipboardStores();
    const workspace: CodeWorkspaceTabInfo = {
      repoRoot: "/repo/app",
      workspaceId: "ws-clip-split-same",
      workspaceInstanceId: "instance-clip-split-same",
      name: "Same File Split",
      roots: [{ id: "app", name: "app", path: "/repo/app", kind: "folder" }],
      looseFiles: [],
      initialFile: { kind: "root", rootId: "app", path: "src/main.ts" },
    };
    caseContext.workspaceTestHarness.workspaceMocks.workspaceReadFile.mockImplementation(async (_root: string, _path: string) => (
      caseContext.workspaceTestHarness.file("src/main.ts", "line1: alpha\nline2: beta\nline3: gamma\n")
    ));

    window.localStorage.setItem("taomni.codeWorkspace.layout.v1.instance-clip-split-same", JSON.stringify({
      version: 1,
      splitOrientation: "vertical",
      activeEditorGroupId: "primary",
      editorGroups: {
        primary: {
          openOrder: ["root:app:src/main.ts"],
          activeKey: "root:app:src/main.ts",
          previewKey: null,
          pinnedKeys: [],
        },
        secondary: {
          openOrder: ["root:app:src/main.ts"],
          activeKey: "root:app:src/main.ts",
          previewKey: null,
          pinnedKeys: [],
        },
      },
    }));

    const registrationRef: { current: WorkspaceCommandRegistration | null; } = { current: null };
    const onCommandsChange = vi.fn((_tabId: string, next: WorkspaceCommandRegistration | null) => {
      registrationRef.current = next;
    });

    const { unmount } = render(
      <StrictMode>
        <CodeWorkspaceTab
          tabId="code-strict-split"
          workspace={workspace}
          onCommandsChange={onCommandsChange}
        />
      </StrictMode>,
    );
    await screen.findAllByTitle("app / src/main.ts");

    const panes = await findEditorPanes();
    const primaryPane = panes.find((p) => p.getAttribute("data-editor-group-id") === "primary");
    const secondaryPane = panes.find((p) => p.getAttribute("data-editor-group-id") === "secondary");
    await waitFor(() => {
      for (const pane of [primaryPane, secondaryPane]) {
        const editor = pane?.querySelector<HTMLElement>(".cm-editor");
        expect(editor).toBeTruthy();
        expect(EditorView.findFromDOM(editor!)?.state.doc.toString()).toBe("line1: alpha\nline2: beta\nline3: gamma\n");
      }
    });
    const primaryEditor = primaryPane?.querySelector<HTMLElement>(".cm-editor");
    const secondaryEditor = secondaryPane?.querySelector<HTMLElement>(".cm-editor");

    const primaryView = EditorView.findFromDOM(primaryEditor!);
    const secondaryView = EditorView.findFromDOM(secondaryEditor!);
    expect(primaryView).not.toBeNull();
    expect(secondaryView).not.toBeNull();

    const store = acquireClipboardStore("instance-clip-split-same");
    expect(store.getSnapshot().consumerCount).toBe(2);

    // Select line 1 in primary view
    primaryView!.dispatch({
      selection: EditorSelection.range(0, 12), // "line1: alpha"
    });

    fireEvent.mouseDown(primaryPane!);
    await waitFor(() => expect(
      registrationRef.current?.items.find((item) => item.id === "workspace.editor.copy")?.enabled,
    ).toBe(true));

    await act(async () => {
      await registrationRef.current?.executeAction("workspace.editor.copy");
    });

    expect(store.read()?.plainText).toBe("line1: alpha");

    // Select line 3 in secondary view and paste
    secondaryView!.dispatch({
      selection: EditorSelection.range(25, 37), // "line3: gamma"
    });

    fireEvent.mouseDown(secondaryPane!);
    await waitFor(() => expect(
      registrationRef.current?.items.find((item) => item.id === "workspace.editor.paste")?.enabled,
    ).toBe(true));

    await act(async () => {
      await registrationRef.current?.executeAction("workspace.editor.paste");
    });

    await waitFor(() => {
      expect(secondaryView!.state.doc.toString()).toBe("line1: alpha\nline2: beta\nline1: alpha\n");
    });

    // Undo in secondary view through the production entry.
    fireEvent.keyDown(secondaryPane!, { key: "z", ctrlKey: true });
    await waitFor(() => {
      expect(secondaryView!.state.doc.toString()).toBe("line1: alpha\nline2: beta\nline3: gamma\n");
    });

    store.release();
    unmount();
    await new Promise((resolve) => setTimeout(resolve, 20));
    resetWorkspaceClipboardStores();
  });
}
