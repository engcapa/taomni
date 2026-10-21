import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { FindInFilesPanel } from "../../FindInFilesPanel";
import { doneEvent, roots, runSearch, searchMatch, searchMocks } from "./harness";

export function registerFindInFilesPanelLayout2Cases() {

  describe("ED-FIND-003: scope planning in FindInFilesPanel", () => {
    afterEach(async () => {
      cleanup();
      const { useProjectFactsStore } = await import("../../../../../../stores/projectFactsStore");
      useProjectFactsStore.setState({ workspaces: {} });
    });

    const moduleRoots = [{ id: "root-1", name: "app", path: "C:/repo/app", kind: "git" as const }];

    async function seedModuleFacts(generation = 2) {
      const { useProjectFactsStore } = await import("../../../../../../stores/projectFactsStore");
      const { buildProjectStructureSnapshotV2 } = await import("../../../projectStructureModel");
      useProjectFactsStore.setState({ workspaces: {} });
      useProjectFactsStore.setState({
        workspaces: {
          "C:/repo/app": {
            workspaceRoot: "C:/repo/app",
            generation,
            status: "ready",
            reason: null,
            fingerprint: "fp",
            structure: buildProjectStructureSnapshotV2({
              generation,
              modules: [
                {
                  id: "com.example:core",
                  buildSystem: "maven",
                  root: "C:/repo/app/core",
                  sourceRoots: ["C:/repo/app/core/src/main/java"],
                  testRoots: [],
                  generatedRoots: [],
                  excludedRoots: [],
                  dependencyFingerprint: "cp",
                },
              ],
              source: "maven-model",
            }),
            provenance: null,
            isStale: false,
            abortController: null,
          },
        },
      });
    }

    it("shows the scope selector and fails module scope closed without facts (A1/A3)", async () => {
      const { useProjectFactsStore } = await import("../../../../../../stores/projectFactsStore");
      useProjectFactsStore.setState({ workspaces: {} });
      render(<FindInFilesPanel roots={moduleRoots} onOpenMatch={vi.fn()} />);

      const scopeSelect = screen.getByLabelText("Search scope") as HTMLSelectElement;
      expect(scopeSelect.value).toBe("project");
      fireEvent.change(scopeSelect, { target: { value: "module" } });

      expect(await screen.findByTestId("code-workspace-find-scope-notice")).toBeInTheDocument();
      expect(searchMocks.workspaceSearchStart).not.toHaveBeenCalled();
    });

    it("searches exact module roots from ready facts (A1)", async () => {
      await seedModuleFacts(2);
      render(<FindInFilesPanel roots={moduleRoots} onOpenMatch={vi.fn()} />);

      fireEvent.change(screen.getByLabelText("Search scope"), { target: { value: "module" } });
      // Module picker lists the ready facts module.
      expect(screen.getByLabelText("Search module")).toBeInTheDocument();
      const emit = await runSearch();

      expect(searchMocks.workspaceSearchStart).toHaveBeenCalledWith(
        "search-1",
        expect.arrayContaining([
          expect.objectContaining({ path: "C:/repo/app/core" }),
          expect.objectContaining({ path: "C:/repo/app/core/src/main/java" }),
        ]),
        "needle",
        expect.anything(),
      );

      act(() => {
        emit({
          ...doneEvent(),
          kind: "batch",
          matches: [
            searchMatch({ rootPath: "C:/repo/app", path: "core/src/main/java/Service.java", lineText: "needle service" }),
            searchMatch({ rootPath: "C:/repo/app", path: "other/Outside.java", lineText: "needle outside" }),
          ],
        });
        emit(doneEvent({ totalMatches: 1 }));
      });
      // Client-side scope filter keeps the module match and drops the outsider.
      expect(screen.getByText("app/core/src/main/java/Service.java")).toBeInTheDocument();
      expect(screen.queryByText("app/other/Outside.java")).not.toBeInTheDocument();
    });

    it("drops superseded search batches when a new search starts (A4)", async () => {
      render(<FindInFilesPanel roots={roots} onOpenMatch={vi.fn()} />);

      searchMocks.newWorkspaceSearchId
        .mockReturnValueOnce("search-1")
        .mockReturnValueOnce("search-2");
      const unlisten = vi.fn();
      searchMocks.subscribeWorkspaceSearch.mockResolvedValue(unlisten);
      searchMocks.workspaceSearchStart.mockResolvedValue("search-2");

      const input = screen.getByLabelText("Search query");
      fireEvent.change(input, { target: { value: "first" } });
      fireEvent.keyDown(input, { key: "Enter" });
      await waitFor(() => expect(searchMocks.workspaceSearchStart).toHaveBeenCalledTimes(1));
      const firstEmit = searchMocks.subscribeWorkspaceSearch.mock.calls.at(-1)![1];

      fireEvent.change(input, { target: { value: "second" } });
      fireEvent.keyDown(input, { key: "Enter" });
      await waitFor(() => expect(searchMocks.workspaceSearchStart).toHaveBeenCalledTimes(2));

      // Late batch from the superseded search is ignored.
      act(() => {
        firstEmit({ ...doneEvent(), kind: "batch", matches: [searchMatch({ lineText: "stale batch" })] });
        firstEmit(doneEvent());
      });
      expect(screen.queryByText(/stale batch/)).not.toBeInTheDocument();
      expect(searchMocks.workspaceSearchCancel).toHaveBeenCalledWith("search-1");
    });

    it("stops publishing when facts generation moves mid-search (A4)", async () => {
      await seedModuleFacts(2);
      render(<FindInFilesPanel roots={moduleRoots} onOpenMatch={vi.fn()} />);

      fireEvent.change(screen.getByLabelText("Search scope"), { target: { value: "module" } });
      const emit = await runSearch();

      // Facts refresh bumps the generation while results stream in.
      const { useProjectFactsStore } = await import("../../../../../../stores/projectFactsStore");
      const live = useProjectFactsStore.getState().getWorkspaceFacts("C:/repo/app");
      useProjectFactsStore.setState({
        workspaces: { "C:/repo/app": { ...live, generation: 3 } },
      });

      act(() => {
        emit({
          ...doneEvent(),
          kind: "batch",
          matches: [searchMatch({ rootPath: "C:/repo/app", path: "core/src/main/java/Service.java", lineText: "late needle" })],
        });
      });

      expect(screen.queryByText(/late needle/)).not.toBeInTheDocument();
      expect(await screen.findByTestId("code-workspace-find-error")).toBeInTheDocument();
      expect(screen.getByTestId("code-workspace-find-error")).toHaveTextContent(/G2 -> G3/);
    });
  });
}
