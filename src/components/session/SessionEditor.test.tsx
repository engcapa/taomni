import "./tests/sessionEditor/harness";
import { registerSessionCapabilityCases } from "./tests/sessionEditor/capability.cases";
import { registerSessionDefaultCases } from "./tests/sessionEditor/defaults.cases";
import { cleanup } from "@testing-library/react";
import { afterEach, beforeEach, describe } from "vitest";
import { setLocale } from "../../lib/i18n";
import { registerSessionEditorClipboard1Cases } from "./tests/sessionEditor/clipboard1.cases";
import { registerSessionEditorClipboard2Cases } from "./tests/sessionEditor/clipboard2.cases";
import { ipcMocks, mailMocks } from "./tests/sessionEditor/harness";
import { registerSessionEditorLifecycle3Cases } from "./tests/sessionEditor/lifecycle3.cases";
import { registerSessionEditorLifecycle4Cases } from "./tests/sessionEditor/lifecycle4.cases";

describe("SessionEditor SSH settings tabs", { timeout: 15_000 }, () => {
  beforeEach(() => {
    setLocale("en");
    Object.values(ipcMocks).forEach((mock) => {
      if (typeof mock === "function" && "mockReset" in mock) {
        (mock as any).mockReset();
      }
    });
    Object.values(mailMocks).forEach((mock) => {
      if (typeof mock === "function" && "mockReset" in mock) {
        (mock as any).mockReset();
      }
    });
    window.localStorage.clear();
    ipcMocks.listSessions.mockResolvedValue([]);
    ipcMocks.listSessionGroups.mockResolvedValue([]);
    ipcMocks.saveSession.mockResolvedValue(undefined);
    ipcMocks.deleteSession.mockResolvedValue(undefined);
    ipcMocks.saveSessionGroup.mockResolvedValue(undefined);
    ipcMocks.testSshConnection.mockResolvedValue("Connection successful");
    ipcMocks.listSystemFonts.mockResolvedValue(["Cascadia Mono", "Consolas", "JetBrains Mono", "Source Code Pro"]);
    ipcMocks.listLocalShells.mockResolvedValue([
      {
        id: "bash",
        name: "Bash",
        path: "/bin/bash",
        args: ["--login"],
        isDefault: true,
        canElevate: false,
      },
    ]);
    ipcMocks.hbaseTestConnection.mockResolvedValue("HBase REST connection OK");
    ipcMocks.dbTestConnection.mockResolvedValue("Database connection OK");
    ipcMocks.listWslDistros.mockResolvedValue([
      { name: "Ubuntu", isDefault: true, state: "Stopped", version: 2 },
    ]);
    ipcMocks.vaultPut.mockResolvedValue({ id: "vault-pwd", reference: "vault:pwd" });
    mailMocks.mailOAuthAuthorize.mockResolvedValue({
      tokenRef: "vault:oauth-token",
      expiresAt: 1_800_000_000,
      scope: "mail.scope",
      tokenType: "Bearer",
    });
    mailMocks.mailOAuthDeviceStart.mockResolvedValue({
      deviceCode: "device-code",
      userCode: "ABCD-EFGH",
      verificationUri: "https://microsoft.com/devicelogin",
      message: "Use code ABCD-EFGH",
      expiresIn: 900,
      interval: 1,
    });
    mailMocks.mailOAuthDeviceComplete.mockResolvedValue({
      tokenRef: "vault:oauth-token",
      expiresAt: 1_800_000_000,
      scope: "mail.scope",
      tokenType: "Bearer",
    });
  });

  afterEach(() => {
    setLocale("en");
    cleanup();
  });
  registerSessionEditorClipboard1Cases();
  registerSessionCapabilityCases();
  registerSessionDefaultCases();
  registerSessionEditorClipboard2Cases();
  registerSessionEditorLifecycle3Cases();
  registerSessionEditorLifecycle4Cases();
});
