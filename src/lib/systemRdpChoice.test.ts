import { beforeEach, describe, expect, it, vi } from "vitest";

const probe = vi.fn();
const openSettings = vi.fn();
const choice = vi.fn();
const confirm = vi.fn();

vi.mock("./servers", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./servers")>();
  return {
    ...actual,
    probeSystemRdp: () => probe(),
    openSystemRdpSettings: () => openSettings(),
  };
});
vi.mock("./appDialogs", () => ({
  choiceAppDialog: (options: unknown) => choice(options),
  confirmAppDialog: (options: unknown) => confirm(options),
}));

import { decideRdpStart } from "./systemRdpChoice";
import { defaultConfig, systemRdpAlternativePort, type SystemRdpStatus } from "./servers";

const running: SystemRdpStatus = {
  applicable: true,
  supported: true,
  enabled: true,
  serviceRunning: true,
  port: 3389,
  isAdmin: true,
  recommendation: "use-system",
};

describe("decideRdpStart", () => {
  beforeEach(() => {
    probe.mockReset();
    openSettings.mockReset();
    choice.mockReset();
    confirm.mockReset();
  });

  it("starts without prompting where the check does not apply", async () => {
    probe.mockResolvedValue({ applicable: false, recommendation: "taomni" });
    const decision = await decideRdpStart(defaultConfig("rdp"));
    expect(decision.proceed).toBe(true);
    expect(choice).not.toHaveBeenCalled();
    expect(confirm).not.toHaveBeenCalled();
  });

  it("keeps the running system Remote Desktop unless the user picks Taomni", async () => {
    probe.mockResolvedValue(running);
    choice.mockResolvedValue("primary");
    const kept = await decideRdpStart({ ...defaultConfig("rdp"), port: 3389 });
    expect(kept.proceed).toBe(false);

    choice.mockResolvedValue("secondary");
    const chosen = await decideRdpStart({ ...defaultConfig("rdp"), port: 3389 });
    expect(chosen.proceed).toBe(true);
    expect(chosen.patch).toEqual({ systemRdpChoice: "taomni", port: 3390 });
  });

  it("opens the system settings instead of starting when asked", async () => {
    probe.mockResolvedValue({
      ...running,
      enabled: false,
      serviceRunning: false,
      recommendation: "enable-system",
    });
    choice.mockResolvedValue("primary");
    const decision = await decideRdpStart(defaultConfig("rdp"));
    expect(decision.proceed).toBe(false);
    expect(openSettings).toHaveBeenCalledTimes(1);
  });

  it("asks a non-administrator before using Taomni and honours cancel", async () => {
    probe.mockResolvedValue({
      ...running,
      enabled: false,
      serviceRunning: false,
      isAdmin: false,
      recommendation: "needs-admin",
    });
    confirm.mockResolvedValue(false);
    expect((await decideRdpStart(defaultConfig("rdp"))).proceed).toBe(false);
    confirm.mockResolvedValue(true);
    const decision = await decideRdpStart(defaultConfig("rdp"));
    expect(decision.proceed).toBe(true);
    expect(decision.patch?.systemRdpChoice).toBe("taomni");
  });

  it("does not ask again after the choice is remembered but still avoids the system port", async () => {
    probe.mockResolvedValue(running);
    const decision = await decideRdpStart({ ...defaultConfig("rdp"), port: 3389, systemRdpChoice: "taomni" });
    expect(choice).not.toHaveBeenCalled();
    expect(decision.proceed).toBe(true);
    expect(decision.patch).toEqual({ port: 3390 });
  });

  it("never blocks the start when the probe fails", async () => {
    probe.mockRejectedValue(new Error("registry unavailable"));
    const decision = await decideRdpStart(defaultConfig("rdp"));
    expect(decision.proceed).toBe(true);
    expect(decision.notes.join(" ")).toContain("registry unavailable");
  });
});

describe("systemRdpAlternativePort", () => {
  it("only moves away from a port the running system host owns", () => {
    expect(systemRdpAlternativePort(running, 3389)).toBe(3390);
    expect(systemRdpAlternativePort(running, 0)).toBe(3390);
    expect(systemRdpAlternativePort(running, 4000)).toBeNull();
    expect(systemRdpAlternativePort({ ...running, serviceRunning: false }, 3389)).toBeNull();
    expect(systemRdpAlternativePort({ ...running, port: 3390 }, 3390)).toBe(3391);
    expect(systemRdpAlternativePort(null, 3389)).toBeNull();
  });
});
