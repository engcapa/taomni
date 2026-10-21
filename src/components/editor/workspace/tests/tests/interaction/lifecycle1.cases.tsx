import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { useCallback, useRef, useState, type ComponentProps } from "react";
import { expect, it, vi } from "vitest";
import { useAppStore } from "../../../../../../stores/appStore";
import type { CodeWorkspaceTabInfo } from "../../../../../../types";
import { CodeWorkspaceTab } from "../../../../CodeWorkspaceTab";
import type { WorkspaceCommandRegistration } from "../../../workspaceCommands";
import { type registerInteractionCasesFixture } from "../../interaction.cases";

export interface registerinteractionLifecycle1CasesContext {
  workspaceTestHarness: registerInteractionCasesFixture;
}

export function registerinteractionLifecycle1Cases(caseContext: registerinteractionLifecycle1CasesContext) {
  it("mounts project facts for the workspace root and routes status refresh to the store", async () => {
    caseContext.workspaceTestHarness.projectFactsMock.state.status = "loading";
    caseContext.workspaceTestHarness.projectFactsMock.state.reason = "Loading project build facts...";
    caseContext.workspaceTestHarness.projectFactsMock.state.generation = 4;
    caseContext.workspaceTestHarness.descriptorDiscoveryMock.state.status = "descriptor-only";
    caseContext.workspaceTestHarness.descriptorDiscoveryMock.state.discovery = {
      status: "descriptor-only",
      generation: 1,
      descriptors: [{
        path: "/repo/app/pom.xml",
        buildSystem: "maven",
        name: "app",
        root: "/repo/app",
        rawContentSha256: "descriptor-hash",
        inferredExcludedRoots: ["/repo/app/target"],
      }],
      excludedRoots: ["/repo/app/target"],
      diagnostics: [],
    };

    const workspace: CodeWorkspaceTabInfo = {
      repoRoot: "/repo/app",
      workspaceId: "ws-project-facts",
      workspaceInstanceId: "instance-project-facts",
      name: "Project Facts",
      roots: [{ id: "app", name: "app", path: "/repo/app", kind: "git" }],
      looseFiles: [],
    };

    caseContext.workspaceTestHarness.renderWorkspace(workspace);

    expect(await screen.findByTestId("project-facts-status-badge")).toHaveTextContent("Maven Discovered");
    expect(await screen.findByTestId("project-facts-status-badge")).toHaveTextContent("Loading Facts");
    expect(caseContext.workspaceTestHarness.projectFactsMock.useProjectFacts).toHaveBeenCalledWith(
      "/repo/app",
      expect.objectContaining({ autoFetch: true }),
    );
    expect(caseContext.workspaceTestHarness.descriptorDiscoveryMock.useProjectDescriptorDiscovery).toHaveBeenCalledWith(
      "/repo/app",
      { autoRefresh: true },
    );

    fireEvent.click(screen.getByTestId("project-facts-refresh-btn"));
    expect(caseContext.workspaceTestHarness.projectFactsMock.refresh).toHaveBeenCalledTimes(1);
    expect(caseContext.workspaceTestHarness.descriptorDiscoveryMock.refresh).toHaveBeenCalledTimes(1);
  });
  it("keeps the analysis panel mounted when an imported baseline is invalid", async () => {
    const workspace: CodeWorkspaceTabInfo = {
      repoRoot: "",
      workspaceId: "ws-invalid-baseline",
      workspaceInstanceId: "instance-invalid-baseline",
      name: "Invalid Baseline",
      roots: [],
      looseFiles: [],
    };
    caseContext.workspaceTestHarness.clipboardMocks.readText.mockResolvedValueOnce("not json");

    caseContext.workspaceTestHarness.renderWorkspace(workspace);

    fireEvent.click(screen.getByTestId("code-workspace-bottom-tab-analysis"));
    expect(await screen.findByTestId("code-workspace-analysis-panel")).toBeVisible();
    fireEvent.click(screen.getByTestId("analysis-baseline-import"));

    await waitFor(() => expect(useAppStore.getState().statusMessage).toBe(
      "Inspection baseline is not valid JSON",
    ));
    expect(screen.getByTestId("analysis-inspection-suppressions")).toBeVisible();
    expect(screen.getByTestId("code-workspace-tab")).toBeVisible();
  });
  it("persists editor intelligence settings per workspace and reloads defaults after rebinding", async () => {
    const first: CodeWorkspaceTabInfo = {
      repoRoot: "",
      workspaceId: "ws-intelligence-settings-a",
      workspaceInstanceId: "instance-intelligence-settings-a",
      name: "Intelligence Settings A",
      roots: [],
      looseFiles: [],
    };
    const second: CodeWorkspaceTabInfo = {
      ...first,
      workspaceId: "ws-intelligence-settings-b",
      workspaceInstanceId: "instance-intelligence-settings-b",
      name: "Intelligence Settings B",
    };
    const registrationRef: { current: WorkspaceCommandRegistration | null; } = { current: null };
    const onCommandsChange = vi.fn((_tabId: string, next: WorkspaceCommandRegistration | null) => {
      if (next) registrationRef.current = next;
    });
    const rendered = caseContext.workspaceTestHarness.renderWorkspace(first, { onCommandsChange });
    await screen.findByText("Code · Intelligence Settings A");
    await waitFor(() => expect(
      registrationRef.current?.items.some((item) => item.id === "workspace.intelligenceSettings"),
    ).toBe(true));

    act(() => {
      expect(registrationRef.current?.execute("workspace.intelligenceSettings")).toBe(true);
    });
    await screen.findByTestId("workspace-intelligence-settings-dialog");
    fireEvent.click(screen.getByTestId("workspace-quick-doc-hover-enabled"));
    fireEvent.change(screen.getByTestId("workspace-quick-doc-hover-delay"), {
      target: { value: "825" },
    });
    fireEvent.change(screen.getByTestId("workspace-quick-doc-default-target"), {
      target: { value: "tool-window" },
    });
    fireEvent.click(screen.getByTestId("workspace-parameter-info-auto-popup"));
    fireEvent.change(screen.getByTestId("workspace-parameter-info-delay"), {
      target: { value: "275" },
    });
    fireEvent.click(screen.getByTestId("workspace-intelligence-settings-apply"));

    expect(JSON.parse(
      window.localStorage.getItem(
        "taomni.codeWorkspace.intelligence.v1.instance-intelligence-settings-a",
      ) ?? "null",
    )).toEqual(expect.objectContaining({
      quickDoc: {
        showOnHover: false,
        hoverDelayMs: 825,
        defaultTarget: "tool-window",
      },
      parameterInfo: {
        autoPopup: false,
        delayMs: 275,
        showFullSignatures: false,
      },
    }));
    expect(window.localStorage.getItem(
      "taomni.codeWorkspace.intelligence.v1.instance-intelligence-settings-b",
    )).toBeNull();

    rendered.rerender(
      <CodeWorkspaceTab
        tabId="tab-code"
        workspace={second}
        visible
        onCommandsChange={onCommandsChange}
      />,
    );
    await screen.findByText("Code · Intelligence Settings B");
    await waitFor(() => expect(
      registrationRef.current?.items.some((item) => item.id === "workspace.intelligenceSettings"),
    ).toBe(true));
    act(() => {
      expect(registrationRef.current?.execute("workspace.intelligenceSettings")).toBe(true);
    });

    await screen.findByTestId("workspace-intelligence-settings-dialog");
    expect(screen.getByTestId("workspace-quick-doc-hover-enabled")).toBeChecked();
    expect(screen.getByTestId("workspace-quick-doc-hover-delay")).toHaveValue(300);
    expect(screen.getByTestId("workspace-quick-doc-default-target")).toHaveValue("popup");
    expect(screen.getByTestId("workspace-parameter-info-auto-popup")).toBeChecked();
    expect(screen.getByTestId("workspace-parameter-info-delay")).toHaveValue(0);
  });
  it("settles when the parent stores command registrations in state", async () => {
    const workspace: CodeWorkspaceTabInfo = {
      repoRoot: "",
      workspaceId: "ws-registration-feedback",
      workspaceInstanceId: "instance-registration-feedback",
      name: "Registration Feedback Workspace",
      roots: [],
      looseFiles: [],
    };
    let parentRenderCount = 0;

    function RegistrationHost() {
      const renderCount = useRef(0);
      renderCount.current += 1;
      parentRenderCount = Math.max(parentRenderCount, renderCount.current);
      if (renderCount.current > 20) {
        throw new Error("Command registration feedback did not settle");
      }

      const [, setRegistrations] = useState<Record<string, unknown>>({});
      const handleCommandsChange = useCallback<
        NonNullable<ComponentProps<typeof CodeWorkspaceTab>["onCommandsChange"]>
      >((tabId, registration) => {
        setRegistrations((current) => {
          if (registration) {
            return current[tabId] === registration
              ? current
              : { ...current, [tabId]: registration };
          }
          if (!(tabId in current)) return current;
          const next = { ...current };
          delete next[tabId];
          return next;
        });
      }, []);

      return (
        <CodeWorkspaceTab
          tabId="tab-code-feedback"
          workspace={workspace}
          visible
          onCommandsChange={handleCommandsChange}
        />
      );
    }

    render(<RegistrationHost />);

    expect(await screen.findByText("Code · Registration Feedback Workspace")).toBeInTheDocument();
    await act(async () => {
      await Promise.resolve();
    });
    expect(parentRenderCount).toBeGreaterThan(1);
    expect(parentRenderCount).toBeLessThan(20);
  });
  it("ED-FINDFOCUS-001 leaves Find Enter and Escape to the real panel in the workspace capture phase", async () => {
    const { EditorView } = await import("@codemirror/view");
    const source = "Project tree example\nThe editor buffer should survive tree navigation.\n";
    const workspace: CodeWorkspaceTabInfo = {
      repoRoot: "/repo/app", workspaceId: "ws-find-focus", workspaceInstanceId: "instance-find-focus",
      name: "Find Focus", roots: [{ id: "app", name: "app", path: "/repo/app", kind: "folder" }],
      looseFiles: [], initialFile: { kind: "root", rootId: "app", path: "example.txt" },
    };
    caseContext.workspaceTestHarness.workspaceMocks.workspaceListDir.mockResolvedValue([caseContext.workspaceTestHarness.entry("example.txt", "example.txt")]);
    caseContext.workspaceTestHarness.workspaceMocks.workspaceReadFile.mockResolvedValue(caseContext.workspaceTestHarness.file("example.txt", source));
    const rendered = caseContext.workspaceTestHarness.renderWorkspace(workspace);
    await screen.findByTitle("app / example.txt");
    const content = rendered.container.querySelector<HTMLElement>(".cm-content")!;
    const view = EditorView.findFromDOM(content)!;
    act(() => { content.focus(); });
    fireEvent.keyDown(content, { key: "f", code: "KeyF", ctrlKey: true });
    const field = await screen.findByRole("searchbox", { name: "Find" });
    await waitFor(() => expect(field).toHaveFocus());
    fireEvent.input(field, { target: { value: "tree" } });
    expect(view.state.selection.main).toMatchObject({ from: 8, to: 12 });
    fireEvent.keyDown(field, { key: "Enter", code: "Enter" });
    expect(view.state.selection.main).toMatchObject({ from: 54, to: 58 });
    expect(view.state.doc.toString()).toBe(source);
    expect(field).toHaveFocus();
    fireEvent.keyDown(field, { key: "Enter", code: "Enter", shiftKey: true });
    expect(view.state.selection.main).toMatchObject({ from: 8, to: 12 });
    fireEvent.keyDown(field, { key: "Escape", code: "Escape" });
    expect(view.hasFocus).toBe(true);
    expect(view.state.doc.toString()).toBe(source);
    expect(screen.queryByTestId("code-workspace-editor-search")).toBeNull();
  });
}
