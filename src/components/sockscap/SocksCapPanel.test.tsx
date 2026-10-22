import "./tests/socksCapPanel/harness";
import { cleanup } from "@testing-library/react";
import { afterEach, beforeEach, describe, vi } from "vitest";
import {
  sockscapDetectTunConflicts,
  sockscapInstallRedirector,
  sockscapLaunchApp,
  sockscapLaunchedApps,
  sockscapRecover,
  sockscapRedirectorInstallStatus,
  sockscapStart,
  sockscapStatus,
  sockscapStop,
  sockscapStopLaunchedApp,
  sockscapTestUpstream,
} from "../../lib/sockscap";
import { SOCKSCAP_MACOS_SETUP_STORAGE_KEY } from "./SocksCapPanel";
import { registerSocksCapPanelClipboard1Cases } from "./tests/socksCapPanel/clipboard1.cases";
import { defaultTestCfg, dialogOpenMock, fixtureState } from "./tests/socksCapPanel/harness";
import { registerSocksCapPanelHistory2Cases } from "./tests/socksCapPanel/history2.cases";
import { registerSocksCapPanelNavigation3Cases } from "./tests/socksCapPanel/navigation3.cases";

describe("SocksCapPanel Multi-Profile UI", () => {
  beforeEach(() => {
    window.localStorage.removeItem(SOCKSCAP_MACOS_SETUP_STORAGE_KEY);
    fixtureState.currentCfg = JSON.parse(JSON.stringify(defaultTestCfg));
    fixtureState.currentPlatform = "windows";
    fixtureState.linuxTransparentRequiresElevation = false;
    vi.mocked(sockscapStart).mockReset();
    vi.mocked(sockscapStart).mockResolvedValue({
      phase: "active",
      message: "active",
      ruleCount: 0,
      captureBackend: "test",
    });
    vi.mocked(sockscapLaunchApp).mockReset();
    vi.mocked(sockscapLaunchApp).mockImplementation(async (profileId, path, args, launchPreparation) => ({
      pid: 4242,
      profileId,
      path,
      args: args ?? [],
      launchPreparation,
      running: true,
    }));
    vi.mocked(sockscapLaunchedApps).mockReset();
    vi.mocked(sockscapLaunchedApps).mockResolvedValue([]);
    vi.mocked(sockscapStopLaunchedApp).mockReset();
    vi.mocked(sockscapStopLaunchedApp).mockResolvedValue(undefined);
    vi.mocked(sockscapStop).mockReset();
    vi.mocked(sockscapStop).mockResolvedValue({
      phase: "idle",
      message: "idle",
      ruleCount: 0,
      captureBackend: "none",
    });
    vi.mocked(sockscapRecover).mockReset();
    vi.mocked(sockscapRecover).mockResolvedValue(undefined);
    // Default to idle so the panel is unlocked; the lock test overrides this.
    vi.mocked(sockscapStatus).mockReset();
    vi.mocked(sockscapStatus).mockResolvedValue({
      phase: "idle",
      message: "idle",
      ruleCount: 0,
      captureBackend: "none",
    });
    // Default: the pre-flight upstream probe passes.
    vi.mocked(sockscapTestUpstream).mockReset();
    vi.mocked(sockscapTestUpstream).mockResolvedValue("SOCKS5 ok");
    vi.mocked(sockscapDetectTunConflicts).mockReset();
    vi.mocked(sockscapDetectTunConflicts).mockResolvedValue([]);
    vi.mocked(sockscapInstallRedirector).mockReset();
    vi.mocked(sockscapInstallRedirector).mockResolvedValue({
      state: "pendingSystemApproval",
      packageVersion: "0.12.11",
      resourceAvailable: true,
      systemExtensionState: "notRegistered",
      message: "installed",
    });
    vi.mocked(sockscapRedirectorInstallStatus).mockReset();
    vi.mocked(sockscapRedirectorInstallStatus).mockResolvedValue({
      state: "ready",
      packageVersion: "0.12.11",
      resourceAvailable: true,
      systemExtensionState: "enabled",
      message: "ready",
    });
    dialogOpenMock.mockReset();
    dialogOpenMock.mockResolvedValue(null);
  });

  afterEach(() => {
    cleanup();
  });
  registerSocksCapPanelClipboard1Cases();
  registerSocksCapPanelHistory2Cases();
  registerSocksCapPanelNavigation3Cases();
});
