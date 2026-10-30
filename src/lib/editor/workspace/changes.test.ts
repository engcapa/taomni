import { beforeEach, describe, expect, it, vi } from "vitest";
import { subscribeWorkspaceFileChanges } from "./changes";
import { workspaceApplyResourceOperation, workspaceCreateFile, workspaceDeletePath, workspaceRenamePath } from "./resources";
import { workspaceWriteFileEncoded } from "./writing";

const invoke = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke }));

describe("workspace mutation notifications", () => {
  beforeEach(() => invoke.mockReset());

  it("publishes created and saved files only after their disk acknowledgements", async () => {
    const observed = vi.fn();
    const stop = subscribeWorkspaceFileChanges(observed);
    try {
      let finish!: (ack: object) => void;
      const ack = { path: "pom.xml", hash: "saved" };
      invoke.mockReturnValueOnce(new Promise((resolve) => { finish = resolve; }));
      const pending = workspaceCreateFile("/project", "pom.xml");
      expect(observed).not.toHaveBeenCalled();
      finish(ack);
      await expect(pending).resolves.toBe(ack);
      expect(observed).toHaveBeenLastCalledWith({ paths: ["/project/pom.xml"] });
      invoke.mockResolvedValueOnce(ack);
      await expect(workspaceWriteFileEncoded("/project", "pom.xml", "saved", null, "utf-8")).resolves.toBe(ack);
      expect(observed).toHaveBeenCalledTimes(2);
      stop();
      invoke.mockResolvedValueOnce(ack);
      await workspaceCreateFile("/project", "package.json");
      expect(observed).toHaveBeenCalledTimes(2);
    } finally { stop(); }
  });

  it("keeps failed and ignored mutations from invalidating consumers", async () => {
    const observed = vi.fn();
    const stop = subscribeWorkspaceFileChanges(observed);
    try {
      invoke.mockRejectedValueOnce(new Error("disk full"));
      await expect(workspaceCreateFile("/project", "pom.xml")).rejects.toThrow("disk full");
      invoke.mockRejectedValueOnce(new Error("permission denied"));
      await expect(workspaceWriteFileEncoded("/project", "pom.xml", "saved", null, "utf-8")).rejects.toThrow("permission denied");
      invoke.mockResolvedValueOnce({ ignored: true });
      await workspaceApplyResourceOperation("/project", { kind: "delete", path: "pom.xml", recursive: false, ignoreIfNotExists: true });
      expect(observed).not.toHaveBeenCalled();
    } finally { stop(); }
  });

  it("publishes both sides of directory and cross-root renames and completed deletes", async () => {
    const observed = vi.fn();
    const stop = subscribeWorkspaceFileChanges(observed);
    try {
      invoke.mockResolvedValueOnce({ path: "renamed" });
      await workspaceRenamePath("/project", "module", "renamed");
      expect(observed).toHaveBeenLastCalledWith({ paths: ["/project/module", "/project/renamed"] });
      invoke.mockResolvedValueOnce({ ignored: false });
      await workspaceApplyResourceOperation("C:\\Project", {
        kind: "rename", fromPath: "Cargo.toml", toPath: "Cargo.toml", toRepoRoot: "D:\\Other",
        overwrite: false, ignoreIfExists: false,
      });
      expect(observed).toHaveBeenNthCalledWith(2, { paths: ["c:/project/cargo.toml"] });
      expect(observed).toHaveBeenNthCalledWith(3, { paths: ["d:/other/cargo.toml"] });
      invoke.mockResolvedValueOnce(undefined);
      await workspaceDeletePath("/project", "renamed", true);
      expect(observed).toHaveBeenLastCalledWith({ paths: ["/project/renamed"] });
    } finally { stop(); }
  });
});
