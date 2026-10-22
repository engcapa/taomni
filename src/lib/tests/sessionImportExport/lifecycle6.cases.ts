import { expect, it } from "vitest";
import { parseSecureCrtSessions, parseTaomniSessions, serializeTaomniSessions } from "../../sessionImportExport";
import { session } from "./harness";

export function registersessionImportExportLifecycle6Cases() {

  it("imports SecureCRT .ini sessions and decodes hex ports", () => {
    const result = parseSecureCrtSessions([
      'S:"Hostname"=secure.example.com',
      'S:"Username"=ops',
      'S:"Protocol Name"=SSH2',
      'D:"[SSH2] Port"=000008AE',
      'S:"Identity Filename V2"=C:\\keys\\ops.pem',
    ].join("\n"), {
      targetFolder: "SecureCRT",
      sourcePath: "Linux/secure.ini",
      now: 6006,
    });

    expect(result.sessions[0]).toMatchObject({
      name: "secure",
      group_path: "User sessions / SecureCRT / Linux",
      host: "secure.example.com",
      port: 2222,
      username: "ops",
      auth_method: { PrivateKey: { key_path: "C:\\keys\\ops.pem" } },
    });
  });

  it("tracks SecureCRT encrypted passwords without dropping usernames", () => {
    const result = parseSecureCrtSessions([
      'S:"Hostname"=secure.example.com',
      'S:"Username"=ops',
      'S:"Protocol Name"=SSH2',
      'D:"[SSH2] Port"=00000016',
      'S:"Password V2"=02:00112233445566778899aabbccddeeff',
    ].join("\n"), {
      targetFolder: "SecureCRT",
      sourcePath: "Linux/secure.ini",
      now: 6006,
    });

    expect(result.sessions).toHaveLength(1);
    expect(result.sessions[0]).toMatchObject({
      host: "secure.example.com",
      port: 22,
      username: "ops",
      auth_method: "Password",
    });
    expect(result.externalSecretsTool).toBe("securecrt");
    expect(result.secureCrtPasswords).toEqual([
      {
        sessionId: result.sessions[0].id,
        label: "ops@secure.example.com:22",
        encrypted: "02:00112233445566778899aabbccddeeff",
      },
    ]);
  });

  it("preserves LocalShell launch arguments in Taomni round trips", () => {
    const exported = serializeTaomniSessions([
      session({
        name: "Ubuntu",
        session_type: "LocalShell",
        host: "",
        port: 0,
        username: null,
        auth_method: "None",
        options_json: JSON.stringify({
          localShellPath: "wsl.exe",
          localShellArgs: ["-d", "Ubuntu"],
        }),
      }),
    ], null);

    const imported = parseTaomniSessions(exported.text);
    expect(JSON.parse(imported.sessions[0].options_json)).toMatchObject({
      localShellPath: "wsl.exe",
      localShellArgs: ["-d", "Ubuntu"],
    });
  });
}
