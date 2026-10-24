import { describe, expect, it } from "vitest";
import { cleanSessionOptions, sessionCapabilities } from "./sessionCapabilities";

describe("session configuration boundaries", () => {
  it.each(["LocalShell", "Shell", "WSL", "Serial", "File", "Browser", "FTP", "Telnet", "Rlogin", "Mosh", "Proxy", "HBaseShell"])(
    "does not retain irrelevant networking for %s", (type) => {
      const original = { networkSettings: { proxyKind: "ssh-tunnel", jumpPassword: "vault:secret" }, extension: 42 };
      expect(sessionCapabilities(type).network).toBe(false);
      expect(cleanSessionOptions(type, original)).toEqual({ extension: 42 });
      expect(original.networkSettings.jumpPassword).toBe("vault:secret");
    },
  );

  it.each(["SFTP", "RDP", "VNC", "Mail", "MySQL", "S3", "AzureBlob"])(
    "preserves the proxy route but removes terminal forwards for %s", (type) => {
      const result = cleanSessionOptions(type, {
        startupCmd: "touch /tmp/should-not-run", x11: true,
        fileExtraArgs: "--unsafe", pathMappings: [], extension: { version: 2 },
        networkSettings: {
          proxyKind: "socks5", proxySessionId: "corp", localForwards: [{ local: "8080", remote: "db:5432" }],
          keepAlive: true, keepAliveIntervalSecs: "45", tcpNodelay: true, disableNagle: true,
        },
      });
      expect(result.networkSettings).toMatchObject({ proxyKind: "socks5", proxySessionId: "corp" });
      expect(result.networkSettings).not.toHaveProperty("localForwards");
      expect(result.networkSettings).not.toHaveProperty("disableNagle");
      expect(result).not.toHaveProperty("startupCmd");
      expect(result).not.toHaveProperty("fileExtraArgs");
      expect(result.extension).toEqual({ version: 2 });
      if (type !== "SFTP") expect(result.networkSettings).not.toHaveProperty("keepAlive");
    },
  );

  it("preserves real SSH shell and forwarding options", () => {
    const options = { x11: true, startupCmd: "tmux", doNotExit: true, compression: true,
      networkSettings: { localForwards: [{ local: "8080", remote: "db:5432" }], ipVersion: "ipv6", keepAlive: true } };
    expect(cleanSessionOptions("SSH", options)).toEqual(options);
  });

  it("preserves unknown extension options even when names share a protocol prefix", () => {
    const extensions = { dbeaverCredentials: { importId: "external" }, mailLabels: ["work"],
      dbPluginSettings: { version: 2 }, serializableMetadata: true, vncExtension: "custom" };
    expect(cleanSessionOptions("SSH", { ...extensions, dbDatabase: "old", mailOauthTokenRef: "vault:old" }))
      .toEqual(extensions);
  });

  it("exposes Telnet usernames only on supported platforms", () => {
    expect(sessionCapabilities("Telnet", "windows").username).toBe(false);
    expect(sessionCapabilities("Telnet", "linux").username).toBe(true);
    expect(sessionCapabilities("Browser").username).toBe(false);
  });
});

it("removes stale protocol credentials and bookmark behavior when changing session type", () => {
  const result = cleanSessionOptions("SSH", {
    mailOauthTokenRef: "vault:mail", hbaseKeytabPath: "/private/keytab", dbChProtocol: "Native",
    accountKey: "vault:azure", secretAccessKey: "vault:s3", gateway: { password: "vault:rdp" },
    vncViewOnly: true, serialDevice: "COM1", wslDistro: "Ubuntu", localShellPath: "bash",
    bgImage: "/picture.png", openNewWindow: true, reconnect: true, extension: { version: 3 },
  });
  expect(result).toEqual({ bgImage: "/picture.png", openNewWindow: true, reconnect: true, extension: { version: 3 } });
  expect(cleanSessionOptions("Mail", result)).toEqual({ extension: { version: 3 } });
  expect(cleanSessionOptions("MySQL", { dbDatabase: "db", dbCatalog: "cat", dbHttpPort: "8123", dbRedisIndex: "2" }))
    .toEqual({ dbDatabase: "db" });
});
