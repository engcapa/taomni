import "./tests/useWorkspaceLspSession/harness";
import { beforeEach, describe } from "vitest";
import { lspMocks, status } from "./tests/useWorkspaceLspSession/harness";
import { registeruseWorkspaceLspSessionHistory2Cases } from "./tests/useWorkspaceLspSession/history2.cases";
import { registeruseWorkspaceLspSessionLifecycle1Cases } from "./tests/useWorkspaceLspSession/lifecycle1.cases";

describe("useWorkspaceLspSession", () => {
  beforeEach(() => {
    window.localStorage.clear();
    lspMocks.lspDetectServers.mockReset().mockResolvedValue([]);
    lspMocks.lspDiscoverJavaBundles.mockReset().mockResolvedValue([]);
    lspMocks.lspSetJavaHome.mockReset().mockResolvedValue(undefined);
    lspMocks.lspSetJavaVmargs.mockReset().mockResolvedValue("-Xms1024m -Xmx1024m");
    lspMocks.lspSetJavaSettings.mockReset().mockResolvedValue(0);
    lspMocks.lspSetJavaBundles.mockReset().mockResolvedValue(undefined);
    lspMocks.lspOpenDocument.mockReset().mockResolvedValue(status);
    lspMocks.lspChangeDocument.mockReset().mockResolvedValue(status);
    lspMocks.lspSaveDocument.mockReset().mockResolvedValue(status);
    lspMocks.lspCloseDocument.mockReset().mockResolvedValue(status);
    lspMocks.lspStopWorkspace.mockReset().mockResolvedValue(0);
    lspMocks.lspGetDiagnostics.mockReset().mockResolvedValue({ status, diagnostics: [] });
  });
  registeruseWorkspaceLspSessionLifecycle1Cases();
  registeruseWorkspaceLspSessionHistory2Cases();
});
