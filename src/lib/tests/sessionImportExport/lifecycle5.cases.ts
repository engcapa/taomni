import { expect, it } from "vitest";
import {
  parseExceedSessions,
  parseItermDynamicProfiles,
  parseTabbySessions,
  parseWindTermSessions,
  parseXmlConnectionSessions,
  parseXshellFile,
  parseXshellSessions,
  parseXshellZipSessions,
} from "../../sessionImportExport";
import { encodeUtf16LeWithBom, makeStoredZip } from "./harness";

export function registersessionImportExportLifecycle5Cases() {
  it("imports Xshell .xsh INI sessions with source folder hierarchy", () => {
    const result = parseXshellSessions([
      "[Connection]",
      "Host=192.168.1.100",
      "Port=22",
      "Protocol=SSH",
      "[Terminal]",
      "UserName=root",
    ].join("\n"), {
      targetFolder: "Imported",
      sourcePath: "NetSarang/Prod/Web.xsh",
      now: 6001,
    });

    expect(result.sessions).toHaveLength(1);
    expect(result.sessions[0]).toMatchObject({
      name: "Web",
      session_type: "SSH",
      group_path: "User sessions / Imported / NetSarang / Prod",
      host: "192.168.1.100",
      port: 22,
      username: "root",
      created_at: 6001,
    });
  });

  it("imports multiple Xshell .xsh sessions from a ZIP archive", async () => {
    const zip = makeStoredZip({
      "Prod/Web.xsh": [
        "[Connection]",
        "Host=web.example.com",
        "Port=22",
        "Protocol=SSH",
        "UserName=deploy",
      ].join("\n"),
      "Prod/DB.xsh": [
        "[Connection]",
        "Host=db.example.com",
        "Port=2202",
        "Protocol=SSH",
        "[Terminal]",
        "UserName=dba",
      ].join("\n"),
      "notes.txt": "ignored",
    });

    const result = await parseXshellZipSessions(zip, {
      targetFolder: "Imported",
      now: 6007,
    });

    expect(result.sessions).toHaveLength(2);
    expect(result.sessions.map((item) => item.name)).toEqual(["Web", "DB"]);
    expect(result.sessions[0]).toMatchObject({
      group_path: "User sessions / Imported / Prod",
      host: "web.example.com",
      username: "deploy",
    });
    expect(result.sessions[1]).toMatchObject({
      host: "db.example.com",
      port: 2202,
      username: "dba",
    });
  });

  it("imports Xshell public-key auth from the authentication section", () => {
    const result = parseXshellSessions([
      "[SessionInfo]",
      "Version=7",
      "[CONNECTION]",
      "Host=10.0.0.9",
      "Port=22",
      "Protocol=SSH",
      "[CONNECTION:AUTHENTICATION]",
      "Method=Public Key",
      "UserName=deploy",
      "UserKeyName=id_rsa",
    ].join("\n"), { targetFolder: "Imported", now: 6020 });

    expect(result.sessions).toHaveLength(1);
    expect(result.sessions[0]).toMatchObject({
      host: "10.0.0.9",
      username: "deploy",
      auth_method: { PrivateKey: { key_path: "~/.ssh/id_rsa" } },
    });
  });

  it("keeps password auth for Xshell sessions without a public key", () => {
    const result = parseXshellSessions([
      "[CONNECTION]",
      "Host=10.0.0.10",
      "Protocol=SSH",
      "[CONNECTION:AUTHENTICATION]",
      "Method=Password",
      "UserName=ops",
    ].join("\n"), { now: 6021 });

    expect(result.sessions[0]).toMatchObject({
      username: "ops",
      auth_method: "Password",
    });
  });

  it("preserves an explicit key path from the authentication section", () => {
    const result = parseXshellSessions([
      "[CONNECTION]",
      "Host=10.0.0.11",
      "Protocol=SSH",
      "[CONNECTION:AUTHENTICATION]",
      "Method=Public Key",
      "UserName=admin",
      "UserKeyName=C:\\keys\\prod.pem",
    ].join("\n"), { now: 6022 });

    expect(result.sessions[0].auth_method).toEqual({
      PrivateKey: { key_path: "C:\\keys\\prod.pem" },
    });
  });

  it("imports a UTF-16 LE .xsh file via parseXshellFile", async () => {
    const text = [
      "[CONNECTION]",
      "Host=utf16.example.com",
      "Port=22",
      "Protocol=SSH",
      "[CONNECTION:AUTHENTICATION]",
      "UserName=root",
    ].join("\r\n");

    const result = await parseXshellFile(encodeUtf16LeWithBom(text), { now: 6023 });

    expect(result.sessions).toHaveLength(1);
    expect(result.sessions[0]).toMatchObject({
      host: "utf16.example.com",
      username: "root",
    });
  });

  it("imports an Xshell .xts export (ZIP) via parseXshellFile", async () => {
    const zip = makeStoredZip({
      "Web.xsh": [
        "[CONNECTION]",
        "Host=xts.example.com",
        "Port=22",
        "Protocol=SSH",
        "[CONNECTION:AUTHENTICATION]",
        "UserName=deploy",
      ].join("\n"),
    });

    const result = await parseXshellFile(zip, { targetFolder: "Imported", now: 6024 });

    expect(result.sessions).toHaveLength(1);
    expect(result.sessions[0]).toMatchObject({
      name: "Web",
      host: "xts.example.com",
      username: "deploy",
    });
  });

  it("imports Tabby SSH profiles from config.yaml", () => {
    const result = parseTabbySessions([
      "profiles:",
      "  - name: My Server",
      "    type: ssh",
      "    group: Prod / Web",
      "    options:",
      "      host: 10.0.0.5",
      "      port: 2222",
      "      user: ubuntu",
    ].join("\n"), { targetFolder: "Tabby", now: 6002 });

    expect(result.sessions[0]).toMatchObject({
      name: "My Server",
      session_type: "SSH",
      group_path: "User sessions / Tabby / Prod / Web",
      host: "10.0.0.5",
      port: 2222,
      username: "ubuntu",
    });
  });

  it("imports Tabby groups under User sessions when no target folder is selected", () => {
    const result = parseTabbySessions([
      "profiles:",
      "  - name: Ungrouped target",
      "    type: ssh",
      "    group: Lab/Edge",
      "    options:",
      "      host: edge.example.com",
      "      user: admin",
    ].join("\n"), { now: 6010 });

    expect(result.sessions[0]).toMatchObject({
      name: "Ungrouped target",
      group_path: "User sessions / Lab / Edge",
      host: "edge.example.com",
    });
  });

  it("imports Tabby private key paths and password secrets only when enabled", () => {
    const text = [
      "profiles:",
      "  - name: Key Server",
      "    type: ssh",
      "    options:",
      "      host: key.example.com",
      "      user: deploy",
      "      auth: publicKey",
      "      privateKeys:",
      "        - ~/.ssh/deploy_key",
      "  - name: Password Server",
      "    type: ssh",
      "    options:",
      "      host: password.example.com",
      "      user: ops",
      "      auth: password",
      "      password: s3cret",
    ].join("\n");

    const withoutSecrets = parseTabbySessions(text, { targetFolder: "Tabby", now: 6011 });
    expect(withoutSecrets.sessions[0].auth_method).toBe("Password");
    expect(withoutSecrets.secrets).toHaveLength(0);
    expect(withoutSecrets.warnings.join("\n")).toContain("secret import was not enabled");

    const withSecrets = parseTabbySessions(text, {
      targetFolder: "Tabby",
      includeSecrets: true,
      now: 6011,
    });

    expect(withSecrets.sessions[0].auth_method).toEqual({ PrivateKey: { key_path: "~/.ssh/deploy_key" } });
    expect(withSecrets.sessions[1].auth_method).toBe("Password");
    expect(withSecrets.secrets).toEqual([
      {
        sessionId: withSecrets.sessions[1].id,
        kind: "password",
        label: "ops@password.example.com:22",
        value: "s3cret",
      },
    ]);
  });

  it("imports Tabby agent auth, agent forwarding metadata, and jump-host references", () => {
    const result = parseTabbySessions(JSON.stringify({
      profiles: [
        {
          id: "ssh:bastion",
          type: "ssh",
          name: "Bastion",
          options: {
            host: "bastion.example.com",
            port: 2200,
            user: "jump",
          },
        },
        {
          id: "ssh:target",
          type: "ssh",
          name: "Target",
          group: "Prod",
          options: {
            host: "target.internal",
            port: 22,
            user: "app",
            auth: "agent",
            agentForward: true,
            jumpHost: "ssh:bastion",
          },
        },
      ],
    }), { targetFolder: "Imported", now: 6012 });

    expect(result.sessions[1]).toMatchObject({
      name: "Target",
      auth_method: "Agent",
      group_path: "User sessions / Imported / Prod",
    });
    expect(JSON.parse(result.sessions[1].options_json)).toMatchObject({
      agentForward: true,
      useJump: true,
      jumpHost: "bastion.example.com",
      jumpUser: "jump",
      jumpPort: "2200",
    });
    expect(result.warnings.join("\n")).not.toContain("agent authentication is not implemented");
    expect(result.warnings.join("\n")).toContain("agent forwarding");
    expect(result.warnings.join("\n")).toContain("jump-host settings");
  });

  it("resolves Tabby group ids to names from the top-level groups: section", () => {
    const result = parseTabbySessions([
      "version: 7",
      "profiles:",
      "  - name: ubuntu@163.228.82.80:22",
      "    type: ssh",
      "    options:",
      "      host: 163.228.82.80",
      "      user: ubuntu",
      "    group: 6ebfea0f-e7d9-4fdc-ac16-6c80f12b3593",
      "    id: ssh:custom:ubuntu:aee12abe-792f-4868-865a-207344b6ca87",
      "  - name: pi-tpddns",
      "    type: ssh",
      "    options:",
      "      host: yanghuangshi.keepworld.link",
      "      port: 65522",
      "      user: pi",
      "    group: 5fbf8925-ed36-4e55-a221-41a777458587",
      "groups:",
      "  - id: 5fbf8925-ed36-4e55-a221-41a777458587",
      "    name: pi",
      "  - id: 6ebfea0f-e7d9-4fdc-ac16-6c80f12b3593",
      "    name: azure",
      "ssh:",
      "  knownHosts: []",
    ].join("\n"), { targetFolder: "tabby-from", now: 6020 });

    expect(result.sessions).toHaveLength(2);
    expect(result.sessions[0]).toMatchObject({
      name: "ubuntu@163.228.82.80:22",
      group_path: "User sessions / tabby-from / azure",
    });
    expect(result.sessions[1]).toMatchObject({
      name: "pi-tpddns",
      group_path: "User sessions / tabby-from / pi",
    });
  });

  it("warns and falls back to the raw id when a Tabby group id has no matching entry", () => {
    const result = parseTabbySessions([
      "profiles:",
      "  - name: orphan",
      "    type: ssh",
      "    options:",
      "      host: orphan.example.com",
      "    group: 11111111-2222-3333-4444-555555555555",
      "groups:",
      "  - id: aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
      "    name: pi",
    ].join("\n"), { now: 6021 });

    expect(result.sessions[0].group_path).toBe("User sessions / 11111111-2222-3333-4444-555555555555");
    expect(result.warnings.join("\n")).toContain("no matching entry was found under groups:");
  });

  it("warns when Tabby password auth has no plaintext password to import", () => {
    const result = parseTabbySessions([
      "profiles:",
      "  - name: pi-tpddns",
      "    type: ssh",
      "    options:",
      "      host: yanghuangshi.keepworld.link",
      "      port: 65522",
      "      user: pi",
      "      auth: password",
    ].join("\n"), { includeSecrets: true, now: 6022 });

    expect(result.sessions[0].auth_method).toBe("Password");
    expect(result.secrets).toHaveLength(0);
    expect(result.warnings.join("\n")).toContain("OS keychain");
    expect(result.externalVault).toBeUndefined();
  });

  it("flags an externalVault prompt when Tabby config carries an encrypted vault", () => {
    const result = parseTabbySessions([
      "vault:",
      "  version: 1",
      "  contents: AAA=",
      "  keySalt: 0102030405060708",
      "  iv: 01020304050607080102030405060708",
      "profiles:",
      "  - name: db",
      "    type: ssh",
      "    options:",
      "      host: db.example.com",
      "      port: 22",
      "      user: dba",
      "      auth: password",
    ].join("\n"), { includeSecrets: true, now: 6023 });

    expect(result.externalVault).toMatchObject({ tool: "Tabby" });
    expect(result.warnings.join("\n")).toContain("Tabby vault detected");
  });

  it("imports WindTerm JSON sessions recursively", () => {
    const result = parseWindTermSessions(JSON.stringify({
      groups: [
        {
          name: "Prod",
          children: [
            { name: "DB", protocol: "ssh", host: "db.example.com", port: 22, username: "dba" },
          ],
        },
      ],
    }), { targetFolder: "WindTerm", now: 6003 });

    expect(result.sessions[0]).toMatchObject({
      name: "DB",
      group_path: "User sessions / WindTerm / Prod",
      host: "db.example.com",
      username: "dba",
    });
  });

  it("imports iTerm2 profiles by parsing SSH commands", () => {
    const result = parseItermDynamicProfiles(JSON.stringify({
      Profiles: [
        { Name: "Jumpbox", Command: "ssh -p 2200 -l deploy jump.example.com" },
      ],
    }), { targetFolder: "iTerm2", now: 6004 });

    expect(result.sessions[0]).toMatchObject({
      name: "Jumpbox",
      group_path: "User sessions / iTerm2",
      host: "jump.example.com",
      port: 2200,
      username: "deploy",
    });
  });

  it("imports common XML connection exports", () => {
    const result = parseXmlConnectionSessions(
      '<Node Name="Prod SSH" Type="Connection" Protocol="SSH2" Hostname="prod.example.com" Port="2222" Username="root" Folder="mRemote" />',
      { targetFolder: "Imported", now: 6005 },
    );

    expect(result.sessions[0]).toMatchObject({
      name: "Prod SSH",
      session_type: "SSH",
      group_path: "User sessions / Imported / mRemote",
      host: "prod.example.com",
      port: 2222,
      username: "root",
    });
  });

  it("imports XML connection exports that use child elements", () => {
    const result = parseXmlConnectionSessions([
      "<Connection>",
      "<Name>RDM SSH</Name>",
      "<Protocol>SSH</Protocol>",
      "<Host>rdm.example.com</Host>",
      "<Port>2201</Port>",
      "<Username>admin</Username>",
      "<Folder>Remote Desktop Manager</Folder>",
      "</Connection>",
    ].join(""), { targetFolder: "Imported", now: 6005 });

    expect(result.sessions[0]).toMatchObject({
      name: "RDM SSH",
      group_path: "User sessions / Imported / Remote Desktop Manager",
      host: "rdm.example.com",
      port: 2201,
      username: "admin",
    });
  });

  it("imports Exceed key-value session exports with SSH commands", () => {
    const result = parseExceedSessions([
      "[Xstart]",
      "Name=Exceed Xterm",
      "Command=ssh -p 2203 exceed@example.com xterm",
    ].join("\n"), {
      targetFolder: "Exceed",
      sourcePath: "xstart/Exceed Xterm.xs",
      now: 6008,
    });

    expect(result.sessions[0]).toMatchObject({
      name: "Exceed Xterm",
      group_path: "User sessions / Exceed / xstart",
      host: "example.com",
      port: 2203,
      username: "exceed",
    });
  });
}
