import { describe, it, expect } from "vitest";
import {
  DEFAULT_NETWORK_SETTINGS,
  normalizeNetworkSettings,
  toNetworkSettingsPayload,
  proxyKindToLabel,
  proxyLabelToKind,
} from "./networkSettings";

describe("networkSettings proxy kinds", () => {
  it("no longer recognises SOCKS4", () => {
    // Label round-trip only covers supported kinds now.
    expect(proxyLabelToKind("SOCKS 4")).toBe("none");
    expect(proxyKindToLabel("socks5")).toBe("SOCKS 5");
    expect(proxyKindToLabel("ssh-tunnel")).toBe("Local SSH tunnel");
  });
});

describe("normalizeNetworkSettings jump fields", () => {
  it("fills jump defaults when absent", () => {
    const ns = normalizeNetworkSettings({});
    expect(ns.jumpSessionId).toBe("");
    expect(ns.jumpHost).toBe("");
    expect(ns.jumpPort).toBe("22");
    expect(ns.jumpAuthKind).toBe("Password");
    expect(ns.jumpSaveAuth).toBe(false);
  });

  it("reads persisted jump fields and coerces auth kind", () => {
    const ns = normalizeNetworkSettings({
      proxyKind: "ssh-tunnel",
      jumpSessionId: "sess-1",
      jumpHost: "bastion.lan",
      jumpPort: "2222",
      jumpUser: "ops",
      jumpAuthKind: "PrivateKey",
      jumpKeyPath: "~/.ssh/id_ed25519",
      jumpSaveAuth: true,
    });
    expect(ns.proxyKind).toBe("ssh-tunnel");
    expect(ns.jumpSessionId).toBe("sess-1");
    expect(ns.jumpHost).toBe("bastion.lan");
    expect(ns.jumpPort).toBe("2222");
    expect(ns.jumpUser).toBe("ops");
    expect(ns.jumpAuthKind).toBe("PrivateKey");
    expect(ns.jumpKeyPath).toBe("~/.ssh/id_ed25519");
    expect(ns.jumpSaveAuth).toBe(true);
  });

  it("falls back to Password for an unknown jump auth kind", () => {
    const ns = normalizeNetworkSettings({ jumpAuthKind: "bogus" });
    expect(ns.jumpAuthKind).toBe("Password");
  });
});

describe("toNetworkSettingsPayload jump fields", () => {
  it("serialises jump endpoint with numeric port", () => {
    const payload = toNetworkSettingsPayload({
      ...DEFAULT_NETWORK_SETTINGS,
      proxyKind: "ssh-tunnel",
      jumpHost: "  bastion.lan  ",
      jumpPort: "2222",
      jumpUser: "  ops  ",
      jumpAuthKind: "Password",
      jumpPassword: "vault:abc",
    });
    expect(payload.proxyKind).toBe("ssh-tunnel");
    expect(payload.jumpHost).toBe("bastion.lan");
    expect(payload.jumpPort).toBe(2222);
    expect(payload.jumpUser).toBe("ops");
    expect(payload.jumpPassword).toBe("vault:abc");
  });

  it("defaults an invalid jump port to 22", () => {
    const payload = toNetworkSettingsPayload({
      ...DEFAULT_NETWORK_SETTINGS,
      jumpPort: "not-a-port",
    });
    expect(payload.jumpPort).toBe(22);
  });
});
