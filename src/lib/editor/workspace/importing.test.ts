import { beforeEach, describe, expect, it, vi } from "vitest";
import { workspaceImportPaths } from "./importing";
import { subscribeWorkspaceFileChanges } from "./changes";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));
const entry = { name: "bundle", path: "dest/bundle", fileType: "dir", size: 0, mtime: 1, isHidden: false };
beforeEach(() => invoke.mockReset());

describe("workspace import client", () => {
  it("sends absolute sources and a relative destination, then publishes only successful changes", async () => {
    const observed = vi.fn();
    const stop = subscribeWorkspaceFileChanges(observed);
    try {
      let finish!: (value: unknown) => void;
      invoke.mockReturnValueOnce(new Promise((resolve) => { finish = resolve; }));
      const pending = workspaceImportPaths("/two", "dest", ["/external/bundle", "/external/missing"]);
      expect(invoke).toHaveBeenCalledWith("workspace_import_paths", {
        repoRoot: "/two", directory: "dest", sourcePaths: ["/external/bundle", "/external/missing"],
      });
      expect(observed).not.toHaveBeenCalled();
      const response = { imported: [entry], failures: [{ sourcePath: "/external/missing", message: "permission denied" }] };
      finish(response);
      await expect(pending).resolves.toEqual(response);
      expect(observed).toHaveBeenCalledExactlyOnceWith({ paths: ["/two/dest/bundle"] });
    } finally { stop(); }
  });

  it.each([undefined, [], { imported: [null], failures: [] }, { imported: [], failures: [null] }, { imported: [], failures: [{}] }])("rejects malformed acknowledgements: %j", async (value) => {
    invoke.mockResolvedValueOnce(value);
    await expect(workspaceImportPaths("/two", "", ["/source"])).rejects.toThrow(/workspace_import_paths/);
  });

  it("does not announce changes for a failed preflight or an all-failed copy", async () => {
    const observed = vi.fn();
    const stop = subscribeWorkspaceFileChanges(observed);
    try {
      invoke.mockRejectedValueOnce("Path already exists: note.txt");
      await expect(workspaceImportPaths("/two", "", ["/note.txt"])).rejects.toBe("Path already exists: note.txt");
      invoke.mockResolvedValueOnce({ imported: [], failures: [{ sourcePath: "/note.txt", message: "permission denied" }] });
      await workspaceImportPaths("/two", "", ["/note.txt"]);
      expect(observed).not.toHaveBeenCalled();
    } finally { stop(); }
  });
});
