import { describe, expect, it } from "vitest";
import { parseZeroOmegaProxies } from "../../sessionImportExport";

export function registersessionImportExportBehavior4Cases() {

  describe("ZeroOmega proxy import", () => {
    const backup = JSON.stringify({
      schemaVersion: 2,
      "-startupProfileName": "direct",
      "+http-local-3128": {
        profileType: "FixedProfile",
        name: "http-local-3128",
        fallbackProxy: { scheme: "http", host: "127.0.0.1", port: 3128 },
        bypassList: [{ conditionType: "BypassCondition", pattern: "localhost" }],
      },
      "+socks-pi-21080": {
        profileType: "FixedProfile",
        name: "socks-pi-21080",
        fallbackProxy: { scheme: "socks5", host: "192.168.0.110", port: 21080 },
      },
      "+secure-proxy": {
        profileType: "FixedProfile",
        name: "secure-proxy",
        fallbackProxy: { scheme: "https", host: "10.0.0.1", port: 8443 },
      },
      "+auto-switch": {
        profileType: "SwitchProfile",
        name: "auto-switch",
        defaultProfileName: "direct",
      },
    });

    it("imports http and socks5 FixedProfiles as Proxy sessions", () => {
      const result = parseZeroOmegaProxies(backup, { targetFolder: "ZeroOmega", now: 7000 });

      expect(result.sessions).toHaveLength(2);
      expect(result.sessions[0]).toMatchObject({
        name: "http-local-3128",
        session_type: "Proxy",
        group_path: "User sessions / ZeroOmega",
        host: "127.0.0.1",
        port: 3128,
        auth_method: "None",
      });
      expect(JSON.parse(result.sessions[0].options_json)).toEqual({ proxyKind: "http" });

      expect(result.sessions[1]).toMatchObject({
        name: "socks-pi-21080",
        session_type: "Proxy",
        host: "192.168.0.110",
        port: 21080,
      });
      expect(JSON.parse(result.sessions[1].options_json)).toEqual({ proxyKind: "socks5" });
    });

    it("skips unsupported schemes and non-fixed profiles", () => {
      const result = parseZeroOmegaProxies(backup, { now: 7001 });

      // The https FixedProfile is the only skipped entry; SwitchProfile is ignored.
      expect(result.skipped).toBe(1);
      expect(result.warnings.some((w) => w.includes("secure-proxy") && w.includes("https"))).toBe(true);
    });

    it("rejects files that are not valid JSON", () => {
      expect(() => parseZeroOmegaProxies("not json")).toThrow(/not valid JSON/);
    });
  });
}
