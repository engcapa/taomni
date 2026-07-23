import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SocksCapPanel } from "./SocksCapPanel";
import type { SocksCapConfig } from "../../lib/sockscap";

const defaultTestCfg: SocksCapConfig = {
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
};

let currentCfg = { ...defaultTestCfg };

vi.mock("../../lib/sockscap", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../lib/sockscap")>();
  return {
    ...actual,
    sockscapGetConfig: vi.fn(async () => JSON.parse(JSON.stringify(currentCfg))),
    sockscapSetConfig: vi.fn(async (cfg) => {
      currentCfg = JSON.parse(JSON.stringify(cfg));
    }),
    sockscapCapabilities: vi.fn(async () => ({
      platform: "windows",
      globalTcp: true,
      appFilter: true,
      captureBackend: "WinDivert",
      notes: [],
      privilegedRequired: true,
    })),
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
  };
});

describe("SocksCapPanel Multi-Profile UI", () => {
  beforeEach(() => {
    currentCfg = JSON.parse(JSON.stringify(defaultTestCfg));
  });

  afterEach(() => {
    cleanup();
  });

  it("renders profile manager sidebar and default profile", async () => {
    render(<SocksCapPanel />);

    await waitFor(() => {
      expect(screen.getByTestId("sockscap-panel")).toBeInTheDocument();
      expect(screen.getByTestId("sockscap-profile-list")).toBeInTheDocument();
      expect(screen.getByTestId("sockscap-add-profile")).toBeInTheDocument();
    });
  });

  it("allows adding a new profile", async () => {
    render(<SocksCapPanel />);

    await waitFor(() => {
      expect(screen.getByTestId("sockscap-add-profile")).toBeInTheDocument();
    });

    const addBtn = screen.getByTestId("sockscap-add-profile");
    fireEvent.click(addBtn);

    await waitFor(() => {
      expect(currentCfg.profiles.length).toBe(2);
      expect(currentCfg.profiles[1].name).toBe("方案 2");
    });
  });
});
