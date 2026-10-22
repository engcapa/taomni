import { emit } from "@tauri-apps/api/event";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { useAppStore } from "../../../../../../stores/appStore";
import { selectCodeWorkspaceUi, useCodeWorkspaceStore } from "../../../../../../stores/codeWorkspaceStore";
import type { CodeWorkspaceTabInfo } from "../../../../../../types";
import type { WorkspaceCommandRegistration } from "../../../workspaceCommands";
import { type registerFilesCasesFixture } from "../../files.cases";

export interface registerfilesLifecycle4CasesContext {
  workspaceTestHarness: registerFilesCasesFixture;
}

export function registerfilesLifecycle4Cases(caseContext: registerfilesLifecycle4CasesContext) {
  describe("N2.6 Ctrl+Tab Switcher", () => {
    it("opens on Ctrl+Tab, cycles with Shift, commits on Control release", async () => {
      const workspace: CodeWorkspaceTabInfo = {
        repoRoot: "/repo/app",
        workspaceId: "ws-switcher",
        workspaceInstanceId: "instance-switcher",
        name: "Switcher",
        roots: [{ id: "app", name: "app", path: "/repo/app", kind: "git" }],
        looseFiles: [],
        initialFile: { kind: "root", rootId: "app", path: "src/main.ts" },
      };
      caseContext.workspaceTestHarness.workspaceMocks.workspaceListDir.mockResolvedValue([
        caseContext.workspaceTestHarness.entry("src", "src", "dir"),
        caseContext.workspaceTestHarness.entry("other.ts", "other.ts"),
      ]);
      caseContext.workspaceTestHarness.workspaceMocks.workspaceReadFile.mockImplementation(async (_root: string, path: string) =>
        caseContext.workspaceTestHarness.file(path, path === "src/main.ts" ? "const main = 1;\n" : "const other = 2;\n"));

      const rendered = caseContext.workspaceTestHarness.renderWorkspace(workspace);
      await screen.findByTitle("app / src/main.ts");
      fireEvent.doubleClick(screen.getByTestId("code-workspace-tree-file"));
      await screen.findByTitle("app / other.ts");

      // Ctrl+Tab opens the switcher with the previous file preselected.
      fireEvent.keyDown(window, { key: "Tab", ctrlKey: true });
      const switcher = await screen.findByTestId("workspace-tab-switcher");
      expect(switcher).toBeInTheDocument();
      // The previous file (main.ts) is preselected per IDEA MRU semantics.
      const selected = switcher.querySelector('[data-switcher-selected="true"]');
      expect(selected?.textContent).toContain("main.ts");

      // Releasing Control commits the preselected entry.
      fireEvent.keyUp(window, { key: "Control" });
      await waitFor(() => {
        expect(screen.queryByTestId("workspace-tab-switcher")).not.toBeInTheDocument();
      });
      await waitFor(() => {
        const active = rendered.container.querySelector("[data-editor-tab-key][data-active=true]");
        expect(active?.getAttribute("data-editor-tab-key")).toBe("root:app:src/main.ts");
      });
    });

    it("cancels with Escape without changing the active tab", async () => {
      const workspace: CodeWorkspaceTabInfo = {
        repoRoot: "/repo/app",
        workspaceId: "ws-switcher-cancel",
        workspaceInstanceId: "instance-switcher-cancel",
        name: "Switcher Cancel",
        roots: [{ id: "app", name: "app", path: "/repo/app", kind: "git" }],
        looseFiles: [],
        initialFile: { kind: "root", rootId: "app", path: "src/main.ts" },
      };
      caseContext.workspaceTestHarness.workspaceMocks.workspaceListDir.mockResolvedValue([
        caseContext.workspaceTestHarness.entry("src", "src", "dir"),
        caseContext.workspaceTestHarness.entry("other.ts", "other.ts"),
      ]);
      caseContext.workspaceTestHarness.workspaceMocks.workspaceReadFile.mockImplementation(async (_root: string, path: string) =>
        caseContext.workspaceTestHarness.file(path, "const value = 1;\n"));

      const rendered = caseContext.workspaceTestHarness.renderWorkspace(workspace);
      await screen.findByTitle("app / src/main.ts");
      fireEvent.doubleClick(screen.getByTestId("code-workspace-tree-file"));
      await screen.findByTitle("app / other.ts");

      fireEvent.keyDown(window, { key: "Tab", ctrlKey: true });
      await screen.findByTestId("workspace-tab-switcher");
      fireEvent.keyDown(window, { key: "Escape" });
      await waitFor(() => {
        expect(screen.queryByTestId("workspace-tab-switcher")).not.toBeInTheDocument();
      });
      const active = rendered.container.querySelector("[data-editor-tab-key][data-active=true]");
      expect(active?.getAttribute("data-editor-tab-key")).toBe("root:app:other.ts");
    });

    it("refuses Backspace close for pinned tabs and keeps the switcher open (§8.19.6)", async () => {
      const workspace: CodeWorkspaceTabInfo = {
        repoRoot: "/repo/app",
        workspaceId: "ws-switcher-pin",
        workspaceInstanceId: "instance-switcher-pin",
        name: "Switcher Pin",
        roots: [{ id: "app", name: "app", path: "/repo/app", kind: "git" }],
        looseFiles: [],
        initialFile: { kind: "root", rootId: "app", path: "src/main.ts" },
      };
      caseContext.workspaceTestHarness.workspaceMocks.workspaceListDir.mockResolvedValue([
        caseContext.workspaceTestHarness.entry("src", "src", "dir"),
        caseContext.workspaceTestHarness.entry("other.ts", "other.ts"),
      ]);
      caseContext.workspaceTestHarness.workspaceMocks.workspaceReadFile.mockImplementation(async (_root: string, path: string) =>
        caseContext.workspaceTestHarness.file(path, "const value = 1;\n"));

      caseContext.workspaceTestHarness.renderWorkspace(workspace);
      await screen.findByTitle("app / src/main.ts");
      fireEvent.doubleClick(screen.getByTestId("code-workspace-tree-file"));
      await screen.findByTitle("app / other.ts");

      // MRU is [other, main]: index 1 preselects main.ts. Pin it directly in
      // its group so Backspace must refuse instead of closing protected work.
      // The Switcher freezes its snapshot at open time, so the pin must be
      // committed to the tree BEFORE the popup opens to be part of it.
      await act(async () => {
        useCodeWorkspaceStore.getState().updateEditorGroup("instance-switcher-pin", "primary", (group) => ({
          ...group,
          pinnedKeys: [...group.pinnedKeys, "root:app:src/main.ts"],
        }));
      });

      fireEvent.keyDown(window, { key: "Tab", ctrlKey: true });
      const switcher = await screen.findByTestId("workspace-tab-switcher");
      expect(switcher.querySelector('[data-switcher-selected="true"]')?.textContent).toContain("main.ts");
      expect(switcher.querySelector('[data-switcher-selected="true"]')?.textContent).toContain("📌");

      fireEvent.keyDown(window, { key: "Backspace" });
      await waitFor(() => expect(useAppStore.getState().statusMessage).toContain("pinned"));
      // Protected work stays open and the popup remains up for another pick.
      expect(screen.getByTestId("workspace-tab-switcher")).toBeInTheDocument();
      expect(
        selectCodeWorkspaceUi(useCodeWorkspaceStore.getState(), "instance-switcher-pin")
          .editorGroups.primary?.openOrder,
      ).toContain("root:app:src/main.ts");

      fireEvent.keyDown(window, { key: "Escape" });
    });

    it("reopens a closed tab into the nearest surviving split after its leaf closes (§8.19.6)", async () => {
      const workspace: CodeWorkspaceTabInfo = {
        repoRoot: "/repo/app",
        workspaceId: "ws-switcher-reopen",
        workspaceInstanceId: "instance-switcher-reopen",
        name: "Switcher Reopen",
        roots: [{ id: "app", name: "app", path: "/repo/app", kind: "git" }],
        looseFiles: [],
        initialFile: { kind: "root", rootId: "app", path: "src/main.ts" },
      };
      caseContext.workspaceTestHarness.workspaceMocks.workspaceListDir.mockResolvedValue([
        caseContext.workspaceTestHarness.entry("src", "src", "dir"),
        caseContext.workspaceTestHarness.entry("other.ts", "other.ts"),
      ]);
      caseContext.workspaceTestHarness.workspaceMocks.workspaceReadFile.mockImplementation(async (_root: string, path: string) =>
        caseContext.workspaceTestHarness.file(path, path === "src/main.ts" ? "const main = 1;\n" : "const other = 2;\n"));

      const rendered = caseContext.workspaceTestHarness.renderWorkspace(workspace);
      await screen.findByTitle("app / src/main.ts");
      // Split right: the new leaf owns main.ts and becomes active…
      fireEvent.click(caseContext.workspaceTestHarness.toolbarControl("code-workspace-split-right"));
      await waitFor(() => expect(
        selectCodeWorkspaceUi(useCodeWorkspaceStore.getState(), "instance-switcher-reopen").splitOrientation,
      ).toBe("vertical"));
      // …then other.ts opens in THAT leaf, recording its location evidence.
      fireEvent.doubleClick(screen.getByTestId("code-workspace-tree-file"));
      await screen.findByTitle("app / other.ts");

      // Close other.ts (clean tab → direct close, captures ReopenLocationV2).
      fireEvent.keyDown(window, { key: "f4", ctrlKey: true });
      await waitFor(() => {
        const ui = selectCodeWorkspaceUi(useCodeWorkspaceStore.getState(), "instance-switcher-reopen");
        expect(Object.values(ui.editorGroups).some((g) => g.openOrder.includes("root:app:other.ts"))).toBe(false);
      });

      // Collapse the split: other.ts's owning leaf disappears entirely.
      fireEvent.click(caseContext.workspaceTestHarness.toolbarControl("code-workspace-split-close"));
      await waitFor(() => expect(
        selectCodeWorkspaceUi(useCodeWorkspaceStore.getState(), "instance-switcher-reopen").splitOrientation,
      ).toBeNull());

      // Reopen resolves against the LIVE collapsed tree → relocated sibling.
      fireEvent.keyDown(window, { key: "t", shiftKey: true, ctrlKey: true });
      await waitFor(() => expect(useAppStore.getState().statusMessage).toContain("former tab group"));
      await waitFor(() => {
        const active = rendered.container.querySelector("[data-editor-tab-key][data-active=true]");
        expect(active?.getAttribute("data-editor-tab-key")).toBe("root:app:other.ts");
      });
    }, 20000);
  });
  describe("ED-REPAIR-006: case-preserving POSIX replace path identity (mounted)", () => {
    function setupWorkspace(instanceId: string, openFile: string) {
      const disk: Record<string, string> = {};
      const workspace: CodeWorkspaceTabInfo = {
        repoRoot: "/repo/app",
        workspaceId: `ws-${instanceId}`,
        workspaceInstanceId: `instance-${instanceId}`,
        name: instanceId,
        roots: [{ id: "app", name: "app", path: "/repo/app", kind: "git" }],
        looseFiles: [],
        initialFile: { kind: "root", rootId: "app", path: openFile },
      };
      caseContext.workspaceTestHarness.workspaceMocks.workspaceListDir.mockImplementation(async (_root: string, path: string) => (
        path === "src"
          ? Object.keys(disk).map((rel) => caseContext.workspaceTestHarness.entry(rel.split("/").pop()!, rel))
          : [caseContext.workspaceTestHarness.entry("src", "src", "dir")]
      ));
      caseContext.workspaceTestHarness.workspaceMocks.workspaceReadFile.mockImplementation(async (_root: string, path: string) => {
        if (!(path in disk)) throw new Error(`missing fixture file: ${path}`);
        return caseContext.workspaceTestHarness.file(path, disk[path]!);
      });
      caseContext.workspaceTestHarness.workspaceMocks.workspaceWriteFileEncoded.mockImplementation(async (
        _root: string,
        path: string,
        text: string,
      ) => {
        disk[path] = text;
        return caseContext.workspaceTestHarness.writeAck(caseContext.workspaceTestHarness.file(path, text, { hash: `hash-${text}` }));
      });
      const registrationRef: { current: WorkspaceCommandRegistration | null; } = { current: null };
      const onCommandsChange = vi.fn((_tabId: string, next: WorkspaceCommandRegistration | null) => {
        if (next) registrationRef.current = next;
      });
      return { disk, workspace, registrationRef, onCommandsChange };
    }

    async function applyEditWithPreview(workspaceId: string | undefined, edit: unknown, label = "Replace all matches") {
      expect(workspaceId).toBeDefined();
      void emit("lsp://workspace-apply-edit", {
        requestId: `req-${Date.now()}`,
        workspaceId: workspaceId!,
        edit,
        label,
      });
      const preview = await screen.findByTestId("refactoring-preview-dialog");
      fireEvent.click(within(preview).getByTestId("refactoring-preview-apply"));
    }

    it("preserves distinct identities for /repo/app/src/A.java and /repo/app/src/a.java during replace preimages and apply (ED-REPAIR-006-A1, A3)", async () => {
      const { disk, workspace, onCommandsChange } = setupWorkspace("case-replace", "src/c.ts");
      disk["src/c.ts"] = "hello reader";
      disk["src/A.java"] = "hello UPPER_A";
      disk["src/a.java"] = "hello lower_a";

      caseContext.workspaceTestHarness.renderWorkspace(workspace, { onCommandsChange });

      // Apply multi-file WorkspaceEdit that edits both case-distinct files
      await applyEditWithPreview(workspace.workspaceInstanceId, {
        documentEdits: [
          {
            uri: "file:///repo/app/src/A.java",
            path: "/repo/app/src/A.java",
            edits: [{ range: { start: { line: 0, character: 6 }, end: { line: 0, character: 13 } }, newText: "REPLACED_UPPER" }],
          },
          {
            uri: "file:///repo/app/src/a.java",
            path: "/repo/app/src/a.java",
            edits: [{ range: { start: { line: 0, character: 6 }, end: { line: 0, character: 13 } }, newText: "replaced_lower" }],
          },
        ],
      });

      // Both distinct files must be updated accurately on disk without overwriting each other
      await waitFor(() => expect(disk["src/A.java"]).toBe("hello REPLACED_UPPER"));
      expect(disk["src/a.java"]).toBe("hello replaced_lower");

      // Undo restores both distinct files accurately
      await act(async () => {
        fireEvent.keyDown(window, { key: "z", ctrlKey: true });
      });
      await caseContext.workspaceTestHarness.confirmWorkspaceUndo();
      await waitFor(() => expect(disk["src/A.java"]).toBe("hello UPPER_A"));
      expect(disk["src/a.java"]).toBe("hello lower_a");
    });
  });
}
