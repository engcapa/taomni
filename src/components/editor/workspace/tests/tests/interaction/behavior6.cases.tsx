import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { selectCodeWorkspaceUi, useCodeWorkspaceStore } from "../../../../../../stores/codeWorkspaceStore";
import type { CodeWorkspaceTabInfo } from "../../../../../../types";
import { ACCEPTED_IDEA_KEYMAP_DIFFERENCES } from "../../../__fixtures__/ideaKeymapAcceptedDifferences";
import { IDEA_XWIN_KEYMAP } from "../../../__fixtures__/ideaXWinKeymap";
import type { WorkspaceCommandRegistration } from "../../../workspaceCommands";
import { setKeymapPlatformOverride } from "../../../workspaceKeymapPlatform";
import { resetKeymapDefaultsMigrationNoticeForTests } from "../../../workspaceKeymapScheme";
import { type registerInteractionCasesFixture } from "../../interaction.cases";

export interface registerinteractionBehavior6CasesContext {
  workspaceTestHarness: registerInteractionCasesFixture;
}

export function registerinteractionBehavior6Cases(caseContext: registerinteractionBehavior6CasesContext) {
  describe("ED-PARITY-013 IDEA keymap alignment", () => {
    const javaWorkspace: CodeWorkspaceTabInfo = {
      repoRoot: "/repo/app",
      workspaceId: "ws-parity-013",
      workspaceInstanceId: "instance-parity-013",
      name: "Parity 013",
      roots: [{ id: "app", name: "app", path: "/repo/app", kind: "git" }],
      looseFiles: [],
      initialFile: { kind: "root", rootId: "app", path: "src/App.java" },
    };

    let mountCounter = 0;
    let instanceId = "";
    async function mountJava() {
      caseContext.workspaceTestHarness.workspaceMocks.workspaceReadFile.mockResolvedValue(
        caseContext.workspaceTestHarness.file("src/App.java", "public class App {\n  int total = 1;\n}\n"),
      );
      const onCommandsChange = vi.fn();
      mountCounter += 1;
      instanceId = `instance-parity-013-${mountCounter}`;
      const rendered = caseContext.workspaceTestHarness.renderWorkspace(
        { ...javaWorkspace, workspaceId: `ws-parity-013-${mountCounter}`, workspaceInstanceId: instanceId },
        { onCommandsChange },
      );
      await screen.findByTitle("app / src/App.java");
      const latest = () => {
        const calls = onCommandsChange.mock.calls;
        return (calls[calls.length - 1]?.[1] as WorkspaceCommandRegistration).snapshot;
      };
      await waitFor(() => expect(latest().some((item) => item.id === "editor.find")).toBe(true));
      return { rendered, latest };
    }

    it("A4.2: every mapped action's Linux bindings match IDEA XWin, except accepted DEC differences", async () => {
      setKeymapPlatformOverride("linux");
      const { latest } = await mountJava();
      const snapshot = latest();
      const report: string[] = [];
      for (const entry of IDEA_XWIN_KEYMAP) {
        const item = snapshot.find((candidate) => candidate.id === entry.taomniActionId);
        const taomni = item?.keybindings ?? [];
        const idea = entry.ideaBindings;
        const primaryPresent = idea.length === 0 || taomni.includes(idea[0]!);
        const extras = taomni.filter((label) => !idea.includes(label));
        const accepted = ACCEPTED_IDEA_KEYMAP_DIFFERENCES[entry.taomniActionId];
        if ((!item || !primaryPresent || extras.length > 0) && !accepted) {
          report.push(`${entry.taomniActionId} (${entry.ideaActionId}): taomni=[${taomni.join(", ")}] idea=[${idea.join(", ")}]`);
        }
      }
      expect(report).toEqual([]);
    });
    it("A4.1/A1.1: Ctrl+Shift+A opens Find Action without editing; Alt+Enter assigns a shortcut", async () => {
      setKeymapPlatformOverride("linux");
      const { rendered } = await mountJava();
      const content = rendered.container.querySelector<HTMLElement>(".cm-content")!;
      const before = content.textContent;
      await act(async () => {
        fireEvent.keyDown(content, { key: "A", code: "KeyA", ctrlKey: true, shiftKey: true });
      });
      const overlay = await screen.findByTestId("code-workspace-search-everywhere");
      expect(within(overlay).getByRole("tab", { name: "Actions" })).toHaveAttribute("aria-selected", "true");
      const input = within(overlay).getByRole("searchbox");
      fireEvent.change(input, { target: { value: "reformat" } });
      expect(content.textContent).toBe(before);
      expect(within(overlay).getByTestId("search-everywhere-shortcut-workspace.format")).toHaveTextContent("Ctrl+Alt+L");
      expect(overlay.textContent).not.toMatch(/ARROW|ENTER|SPACE|Meta\+/);
      await act(async () => {
        fireEvent.keyDown(input, { key: "Enter", altKey: true });
      });
      await screen.findByTestId("workspace-keymap-settings-dialog");
      expect(screen.getByTestId("keymap-recorder")).toBeInTheDocument();
      expect(screen.getByTestId("keymap-action-filter")).toHaveValue("Format Document");
      // An unbound Ctrl+Shift+letter never edits the document (DEC-013-04).
      fireEvent.keyDown(screen.getByTestId("keymap-recorder"), { key: "Escape" });
      fireEvent.keyDown(window, { key: "Escape" });
      await waitFor(() => expect(screen.queryByTestId("workspace-keymap-settings-dialog")).not.toBeInTheDocument());
      fireEvent.keyDown(content, { key: "Q", code: "KeyQ", ctrlKey: true, shiftKey: true });
      expect(content.textContent).toBe(before);
    });

    it("A4.2: F12 jumps to the last tool window, Shift+Esc hides it, Ctrl+Shift+F12 toggles all", async () => {
      setKeymapPlatformOverride("linux");
      const { rendered } = await mountJava();
      const content = rendered.container.querySelector<HTMLElement>(".cm-content")!;
      await act(async () => {
        fireEvent.keyDown(content, { key: "6", code: "Digit6", altKey: true });
      });
      await waitFor(() => expect(selectCodeWorkspaceUi(useCodeWorkspaceStore.getState(), instanceId).bottomDockOpen).toBe(true));
      await act(async () => {
        useCodeWorkspaceStore.getState().patchInstance(instanceId, { bottomDockOpen: false });
      });
      await act(async () => {
        fireEvent.keyDown(content, { key: "F12", code: "F12" });
      });
      await waitFor(() => {
        const ui = selectCodeWorkspaceUi(useCodeWorkspaceStore.getState(), instanceId);
        expect(ui.bottomDockOpen).toBe(true);
        expect(ui.bottomDockTab).toBe("problems");
      });
      const ui = () => selectCodeWorkspaceUi(useCodeWorkspaceStore.getState(), instanceId);
      // Shift+Esc from the editor hides that last active tool window.
      await act(async () => {
        fireEvent.keyDown(content, { key: "Escape", code: "Escape", shiftKey: true });
      });
      await waitFor(() => expect(ui().bottomDockOpen).toBe(false));
      // Ctrl+Shift+F12 hides every tool window, and the second press restores them.
      expect(ui().languagePanelOpen).toBe(true);
      await act(async () => {
        fireEvent.keyDown(content, { key: "F12", code: "F12", ctrlKey: true, shiftKey: true });
      });
      await waitFor(() => expect(ui().languagePanelOpen).toBe(false));
      await act(async () => {
        fireEvent.keyDown(content, { key: "F12", code: "F12", ctrlKey: true, shiftKey: true });
      });
      await waitFor(() => expect(ui().languagePanelOpen).toBe(true));
    });

    it("A4.2b: Shift+Esc in a tool window hands focus to the editor as it hides", async () => {
      setKeymapPlatformOverride("linux");
      const { rendered } = await mountJava();
      const content = rendered.container.querySelector<HTMLElement>(".cm-content")!;
      const ui = () => selectCodeWorkspaceUi(useCodeWorkspaceStore.getState(), instanceId);
      await act(async () => {
        fireEvent.keyDown(content, { key: "6", code: "Digit6", altKey: true });
      });
      await waitFor(() => expect(ui().bottomDockOpen).toBe(true));
      const dock = await screen.findByTestId("code-workspace-bottom-dock");
      const inside = dock.querySelector<HTMLElement>("button")!;
      act(() => inside.focus());
      expect(dock.contains(document.activeElement)).toBe(true);
      act(() => {
        fireEvent.keyDown(inside, { key: "Escape", code: "Escape", shiftKey: true });
      });
      // No frame has run yet: the editor already owns focus.
      expect(document.activeElement?.classList.contains("cm-content")).toBe(true);
      await waitFor(() => expect(ui().bottomDockOpen).toBe(false));
    });

    it("DEC-013-06: migration notice shows once for a profile with prior workspace data", async () => {
      resetKeymapDefaultsMigrationNoticeForTests();
      window.localStorage.removeItem("taomni.codeWorkspace.keymap.v3:defaults-revision");
      // Seeded settings alone (e.g. a JDK path) are not prior workspace use.
      window.localStorage.setItem("taomni.codeWorkspace.lspJavaHome.v1", "/jdk");
      await mountJava();
      expect(screen.queryByTestId("keymap-migration-notice")).not.toBeInTheDocument();
      cleanup();
      resetKeymapDefaultsMigrationNoticeForTests();
      window.localStorage.removeItem("taomni.codeWorkspace.keymap.v3:defaults-revision");
      window.localStorage.setItem("taomni.codeWorkspace.layout.v2.previous-session", "{}");
      await mountJava();
      const notice = await screen.findByTestId("keymap-migration-notice");
      expect(notice).toHaveTextContent("Taomni Classic");
      fireEvent.click(screen.getByTestId("keymap-migration-dismiss"));
      expect(screen.queryByTestId("keymap-migration-notice")).not.toBeInTheDocument();
      expect(window.localStorage.getItem("taomni.codeWorkspace.keymap.v3:defaults-revision")).toBe("2");
      cleanup();
      resetKeymapDefaultsMigrationNoticeForTests();
      await mountJava();
      expect(screen.queryByTestId("keymap-migration-notice")).not.toBeInTheDocument();
    });
  });
}
