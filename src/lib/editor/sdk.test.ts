import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  invoke: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: mocks.invoke,
}));

import {
  sdkAnalyzeWorkspace,
  sdkDiscoverInstallations,
  sdkGetRegistry,
  sdkRemoveWorkspaceBinding,
  sdkSaveInstallation,
  sdkSaveWorkspaceBinding,
  sdkSetDefault,
  sdkResolveWorkspace,
} from "./sdk";

describe("SDK IPC", () => {
  beforeEach(() => {
    mocks.invoke.mockReset();
  });

  it("loads and discovers SDK installations", async () => {
    mocks.invoke.mockResolvedValue([]);

    await sdkGetRegistry();
    await sdkDiscoverInstallations(["java", "kotlin"]);

    expect(mocks.invoke).toHaveBeenNthCalledWith(1, "sdk_get_registry");
    expect(mocks.invoke).toHaveBeenNthCalledWith(2, "sdk_discover_installations", {
      kinds: ["java", "kotlin"],
    });
  });

  it("saves installation requests as one typed payload", async () => {
    mocks.invoke.mockResolvedValue({});
    const request = {
      kind: "python" as const,
      name: "Python 3.13",
      location: "C:\\Python313",
    };

    await sdkSaveInstallation(request);

    expect(mocks.invoke).toHaveBeenCalledWith("sdk_save_installation", { request });
  });

  it("updates defaults and workspace bindings", async () => {
    mocks.invoke.mockResolvedValue(undefined);
    await sdkSetDefault("java", "jdk-21");
    await sdkSaveWorkspaceBinding({
      scopePath: "D:\\repo",
      kind: "java",
      role: "project",
      mode: "manual",
      sdkId: "jdk-17",
    });
    await sdkRemoveWorkspaceBinding("D:\\repo", "java", "project");

    expect(mocks.invoke).toHaveBeenNthCalledWith(1, "sdk_set_default", {
      request: { kind: "java", sdkId: "jdk-21" },
    });
    expect(mocks.invoke).toHaveBeenNthCalledWith(2, "sdk_save_workspace_binding", {
      request: {
        scopePath: "D:\\repo",
        kind: "java",
        role: "project",
        mode: "manual",
        sdkId: "jdk-17",
      },
    });
    expect(mocks.invoke).toHaveBeenNthCalledWith(3, "sdk_remove_workspace_binding", {
      scopePath: "D:\\repo",
      kind: "java",
      role: "project",
    });
  });

  it("analyzes and resolves one workspace root", async () => {
    mocks.invoke.mockResolvedValue({ profiles: [], resolved: [] });

    await sdkAnalyzeWorkspace("D:\\repo");
    await sdkResolveWorkspace("D:\\repo");

    expect(mocks.invoke).toHaveBeenNthCalledWith(1, "sdk_analyze_workspace", {
      workspaceRoot: "D:\\repo",
    });
    expect(mocks.invoke).toHaveBeenNthCalledWith(2, "sdk_resolve_workspace", {
      workspaceRoot: "D:\\repo",
    });
  });
});
