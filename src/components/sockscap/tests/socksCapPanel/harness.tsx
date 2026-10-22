import { vi } from "vitest";
import { type SocksCapConfig } from "../../../../lib/sockscap";

const { dialogOpenMock } = vi.hoisted(() => ({
  dialogOpenMock: vi.fn(),
}));

vi.mock("@tauri-apps/plugin-dialog", () => ({
  open: dialogOpenMock,
}));

export const defaultTestCfg: SocksCapConfig = {
  enabled: false,
  activeProfileIds: ["default"],
  selectedProfileId: "default",
  profiles: [
    {
      id: "default",
      name: "默认方案",
      icon: "🎮",
      color: null,
      enabled: true,
      priority: 0,
      mode: "global",
      apps: [],
      upstream: { kind: "socks5", sessionId: "", host: "127.0.0.1", port: 1080 },
      ruleMode: "gfwList",
      userRules: [],
      defaultAction: "direct",
    },
  ],
  mode: "global",
  apps: [],
  upstream: { kind: "socks5", sessionId: "", host: "127.0.0.1", port: 1080 },
  ruleMode: "gfwList",
  gfwlist: { enabled: true, url: "https://example.com/gfw.txt", autoRefreshHours: 24 },
  userRules: [],
  bypassCidrs: ["127.0.0.0/8"],
  defaultAction: "direct",
  restoreOnLogin: false,
  blockQuic: true,
};

export let currentCfg = { ...defaultTestCfg };

export let currentPlatform = "windows";

export let linuxTransparentRequiresElevation = false;

vi.mock("../../../../lib/sockscap", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../../lib/sockscap")>();
  return {
    ...actual,
    sockscapGetConfig: vi.fn(async () => JSON.parse(JSON.stringify(currentCfg))),
    sockscapSetConfig: vi.fn(async (cfg) => {
      currentCfg = JSON.parse(JSON.stringify(cfg));
    }),
    sockscapCapabilities: vi.fn(async () =>
      currentPlatform === "linux"
        ? linuxTransparentRequiresElevation
          ? {
            platform: "linux",
            globalTcp: true,
            appFilter: true,
            captureBackend: "nft-cgroup-redirect",
            notes: ["Transparent capture is available after sudo authentication."],
            privilegedRequired: true,
            linux: {
              transparentAvailable: true,
              launchedApplicationAvailable: true,
              launchOnly: false,
              containerized: false,
              transparentUnavailableReason: null,
            },
          }
          : {
            platform: "linux",
            globalTcp: false,
            appFilter: true,
            captureBackend: "linux-app-launch",
            notes: ["Launch configured applications from SocksCap."],
            privilegedRequired: false,
            linux: {
              transparentAvailable: false,
              launchedApplicationAvailable: true,
              launchOnly: true,
              containerized: false,
              transparentUnavailableReason: "Operation not permitted",
            },
          }
        : {
          platform: currentPlatform,
          globalTcp: true,
          appFilter: true,
          captureBackend: "WinDivert",
          notes: [],
          privilegedRequired: true,
        },
    ),
    sockscapStart: vi.fn(async () => ({
      phase: "active",
      message: "active",
      ruleCount: 0,
      captureBackend: "test",
    })),
    sockscapLaunchApp: vi.fn(async (profileId: string, path: string, args: string[], launchPreparation = {}) => ({
      pid: 4242,
      profileId,
      path,
      args: args ?? [],
      launchPreparation,
      running: true,
    })),
    sockscapLaunchedApps: vi.fn(async () => []),
    sockscapStopLaunchedApp: vi.fn(async () => undefined),
    sockscapStop: vi.fn(async () => ({
      phase: "idle",
      message: "idle",
      ruleCount: 0,
      captureBackend: "none",
    })),
    sockscapRecover: vi.fn(async () => undefined),
    sockscapStatus: vi.fn(async () => ({
      phase: "idle",
      message: "idle",
      ruleCount: 0,
      captureBackend: "none",
    })),
    sockscapGfwlistStatus: vi.fn(async () => ({
      loaded: false,
      ruleCount: 0,
      skipped: 0,
      lastRefresh: null,
      source: "",
      error: null,
    })),
    sockscapStatsSnapshot: vi.fn(async () => ({
      flowsTotal: 0,
      flowsProxy: 0,
      flowsDirect: 0,
      flowsBlock: 0,
      bytesUp: 0,
      bytesDown: 0,
    })),
    sockscapHelperStatus: vi.fn(async () => ({
      running: true,
      elevated: true,
      endpoint: "127.0.0.1:1080",
      message: "ok",
      windivert: null,
      pid: 1234,
    })),
    sockscapGetDomainRecords: vi.fn(async () => []),
    sockscapParseShareLink: vi.fn(),
    sockscapTestUpstream: vi.fn(async () => "SOCKS5 ok"),
    sockscapTestCoreUpstream: vi.fn(async () => "ok"),
    sockscapDetectLocalProxies: vi.fn(async () => []),
    sockscapDetectTunConflicts: vi.fn(async () => []),
    sockscapImportSubscription: vi.fn(),
    sockscapInstallRedirector: vi.fn(async () => ({
      state: "pendingSystemApproval",
      packageVersion: "0.12.11",
      resourceAvailable: true,
      systemExtensionState: "notRegistered",
      message: "installed",
    })),
    sockscapRedirectorInstallStatus: vi.fn(async () => ({
      state: "ready",
      packageVersion: "0.12.11",
      resourceAvailable: true,
      systemExtensionState: "enabled",
      message: "ready",
    })),
  };
});

vi.mock("../../../../lib/ipc", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../../lib/ipc")>();
  return {
    ...actual,
    listSessions: vi.fn(async () => []),
    vaultStatus: vi.fn(async () => ({ state: "unlocked" })),
    vaultPut: vi.fn(async () => ({ reference: "vault:test-ref" })),
  };
});

export { dialogOpenMock };

export const fixtureState = {
  get currentCfg() { return currentCfg; },
  set currentCfg(value: typeof currentCfg) { currentCfg = value; },
  get currentPlatform() { return currentPlatform; },
  set currentPlatform(value: typeof currentPlatform) { currentPlatform = value; },
  get linuxTransparentRequiresElevation() { return linuxTransparentRequiresElevation; },
  set linuxTransparentRequiresElevation(value: typeof linuxTransparentRequiresElevation) { linuxTransparentRequiresElevation = value; },
};
