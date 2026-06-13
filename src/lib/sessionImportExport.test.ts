import { describe, expect, it } from "vitest";
import type { SessionConfig } from "./ipc";
import {
  parseCsvSessions,
  parseExceedSessions,
  parseItermDynamicProfiles,
  parseMobaXtermSessions,
  parseTaomniSessions,
  parseSecureCrtSessions,
  parseTabbySessions,
  parseWindTermSessions,
  parseXmlConnectionSessions,
  parseXshellSessions,
  parseXshellZipSessions,
  parseXshellFile,
  parseZeroOmegaProxies,
  serializeCsvSessions,
  serializeMobaXtermSessions,
  serializeTaomniSessions,
} from "./sessionImportExport";

function session(overrides: Partial<SessionConfig> = {}): SessionConfig {
  return {
    id: "session-1",
    name: "Prod",
    session_type: "SSH",
    group_path: "User sessions / Production",
    host: "prod.example.com",
    port: 22,
    username: "deploy",
    auth_method: { PrivateKey: { key_path: "C:\\keys\\deploy.ppk" } },
    options_json: JSON.stringify({
      x11: false,
      compression: true,
      startupCmd: "uptime",
      jumpHost: "bastion.example.com",
      jumpUser: "jump",
      jumpPort: "2222",
      terminalProfile: {
        fontFamily: "JetBrains Mono",
        fontSize: 13,
        fontLigatures: true,
        theme: "classic",
        scrollback: 5000,
        cursorStyle: "block",
        cursorBlink: true,
        showScrollbar: true,
        copyOnSelect: false,
        rightClickBehavior: "menu",
        readOnly: false,
        bracketedPaste: true,
        multilinePasteConfirm: true,
        syntaxMode: "shell",
        loggingEnabled: false,
        logPath: "C:\\secret\\terminal.log",
      },
      disableAiWrite: true,
    }),
    created_at: 100,
    updated_at: 100,
    last_connected_at: null,
    sort_order: 0,
    ...overrides,
  };
}

function encodeUtf16LeWithBom(text: string): Uint8Array {
  const out = new Uint8Array(2 + text.length * 2);
  const view = new DataView(out.buffer);
  view.setUint8(0, 0xff);
  view.setUint8(1, 0xfe);
  for (let i = 0; i < text.length; i += 1) {
    view.setUint16(2 + i * 2, text.charCodeAt(i), true);
  }
  return out;
}

function makeStoredZip(entries: Record<string, string>): Uint8Array {
  const encoder = new TextEncoder();
  const localParts: Uint8Array[] = [];
  const centralParts: Uint8Array[] = [];
  let offset = 0;

  for (const [name, text] of Object.entries(entries)) {
    const nameBytes = encoder.encode(name);
    const data = encoder.encode(text);
    const local = new Uint8Array(30 + nameBytes.length + data.length);
    const localView = new DataView(local.buffer);
    localView.setUint32(0, 0x04034b50, true);
    localView.setUint16(4, 20, true);
    localView.setUint16(6, 0x0800, true);
    localView.setUint16(8, 0, true);
    localView.setUint32(18, data.length, true);
    localView.setUint32(22, data.length, true);
    localView.setUint16(26, nameBytes.length, true);
    local.set(nameBytes, 30);
    local.set(data, 30 + nameBytes.length);
    localParts.push(local);

    const central = new Uint8Array(46 + nameBytes.length);
    const centralView = new DataView(central.buffer);
    centralView.setUint32(0, 0x02014b50, true);
    centralView.setUint16(4, 20, true);
    centralView.setUint16(6, 20, true);
    centralView.setUint16(8, 0x0800, true);
    centralView.setUint16(10, 0, true);
    centralView.setUint32(20, data.length, true);
    centralView.setUint32(24, data.length, true);
    centralView.setUint16(28, nameBytes.length, true);
    centralView.setUint32(42, offset, true);
    central.set(nameBytes, 46);
    centralParts.push(central);

    offset += local.length;
  }

  const centralOffset = offset;
  const centralSize = centralParts.reduce((sum, part) => sum + part.length, 0);
  const eocd = new Uint8Array(22);
  const eocdView = new DataView(eocd.buffer);
  eocdView.setUint32(0, 0x06054b50, true);
  eocdView.setUint16(8, centralParts.length, true);
  eocdView.setUint16(10, centralParts.length, true);
  eocdView.setUint32(12, centralSize, true);
  eocdView.setUint32(16, centralOffset, true);

  const all = [...localParts, ...centralParts, eocd];
  const out = new Uint8Array(all.reduce((sum, part) => sum + part.length, 0));
  let cursor = 0;
  for (const part of all) {
    out.set(part, cursor);
    cursor += part.length;
  }
  return out;
}

describe("Taomni session import/export", () => {
  it("round trips safe session fields and strips local log paths", () => {
    const exported = serializeTaomniSessions([session()], "Production");
    const parsed = JSON.parse(exported.text) as { sessions: Array<{ folder_path: string | null; options: Record<string, unknown> }> };

    expect(parsed.sessions[0].folder_path).toBeNull();
    expect(JSON.stringify(parsed.sessions[0].options)).not.toContain("terminal.log");
    expect(parsed.sessions[0].options.disableAiWrite).toBe(true);

    const result = parseTaomniSessions(exported.text, {
      targetFolder: "Imported",
      now: 1234,
    });

    expect(result.sessions).toHaveLength(1);
    expect(result.sessions[0]).toMatchObject({
      name: "Prod",
      session_type: "SSH",
      group_path: "User sessions / Imported / Production",
      host: "prod.example.com",
      port: 22,
      username: "deploy",
      created_at: 1234,
      updated_at: 1234,
      last_connected_at: null,
    });
    expect(result.sessions[0].auth_method).toEqual({ PrivateKey: { key_path: "C:\\keys\\deploy.ppk" } });
    expect(JSON.parse(result.sessions[0].options_json).disableAiWrite).toBe(true);
  });

  it("tags new exports with the taomni.sessions format", () => {
    const exported = serializeTaomniSessions([session()], null);
    const parsed = JSON.parse(exported.text) as { format: string };
    expect(parsed.format).toBe("taomni.sessions");
    expect(exported.filename.endsWith(".taomni-sessions.json")).toBe(true);
  });

  it("still imports files tagged with the legacy newmob.sessions format", () => {
    // Files exported by pre-rename (NewMob) builds carry format: "newmob.sessions".
    const legacyExport = serializeTaomniSessions([session()], "Production");
    const payload = JSON.parse(legacyExport.text) as Record<string, unknown>;
    payload.format = "newmob.sessions";

    const result = parseTaomniSessions(JSON.stringify(payload), { now: 4321 });
    expect(result.sessions).toHaveLength(1);
    expect(result.sessions[0].name).toBe("Prod");
  });

  it("imports legacy JSON safely and creates duplicate names instead of overwriting", () => {
    const legacy = JSON.stringify({
      sessions: [
        {
          id: "existing-id",
          name: "Prod",
          session_type: "SSH",
          group_path: "User sessions / Production",
          host: "prod.example.com",
          port: 70000,
          username: "deploy",
          auth_method: "Password",
          options_json: JSON.stringify({
            compression: true,
            proxyPass: "secret",
            terminalProfile: { fontSize: 16 },
          }),
          created_at: 1,
          updated_at: 1,
          last_connected_at: 1,
          sort_order: 0,
        },
      ],
    });

    const result = parseTaomniSessions(legacy, {
      targetFolder: "Production",
      now: 2222,
      existingSessions: [session()],
    });

    expect(result.sessions[0].id).not.toBe("existing-id");
    expect(result.sessions[0].name).toBe("Prod (2)");
    expect(result.sessions[0].port).toBe(65535);
    expect(result.sessions[0].last_connected_at).toBeNull();
    expect(result.sessions[0].options_json).toContain("compression");
    expect(result.sessions[0].options_json).not.toContain("proxyPass");
    expect(result.sessions[0].options_json).not.toContain("secret");
  });

  it("round-trips Presto sessions and database options", () => {
    const presto = session({
      id: "presto-1",
      name: "Presto Analytics",
      session_type: "Presto",
      host: "presto.example.com",
      port: 8080,
      username: "analyst",
      auth_method: "None",
      options_json: JSON.stringify({
        dbCatalog: "hive",
        dbDatabase: "sales",
        dbSsl: true,
        dbTimeout: "30",
        passwordRef: "vault:db-presto",
      }),
    });

    const exported = serializeTaomniSessions([presto], null);
    const imported = parseTaomniSessions(exported.text, { now: 3333 });

    expect(imported.sessions).toHaveLength(1);
    expect(imported.sessions[0]).toMatchObject({
      name: "Presto Analytics",
      session_type: "Presto",
      host: "presto.example.com",
      port: 8080,
      username: "analyst",
    });
    expect(JSON.parse(imported.sessions[0].options_json)).toMatchObject({
      dbCatalog: "hive",
      dbDatabase: "sales",
      dbSsl: true,
      dbTimeout: "30",
      passwordRef: "vault:db-presto",
    });
  });
});

describe("CSV session import/export", () => {
  it("exports CSV with escaped fields and imports group paths relative to the target folder", () => {
    const result = serializeCsvSessions([
      session({
        name: "Prod, primary",
        group_path: "User sessions / Production / Web",
        username: "deploy\"ops",
      }),
    ], "Production");

    expect(result.filename).toBe("production.csv");
    expect(result.text).toContain('"Prod, primary",SSH,prod.example.com,22,"deploy""ops",Web');

    const imported = parseCsvSessions(result.text, {
      targetFolder: "Imported",
      now: 5555,
    });

    expect(imported.sessions).toHaveLength(1);
    expect(imported.sessions[0]).toMatchObject({
      name: "Prod, primary",
      session_type: "SSH",
      group_path: "User sessions / Imported / Web",
      username: "deploy\"ops",
      created_at: 5555,
      updated_at: 5555,
    });
  });
});

describe("MobaXterm session import/export", () => {
  it("imports SSH sessions from nested bookmark folders", () => {
    const sshBasic = [
      "0",
      "sesafrazu01",
      "22",
      "azroot",
      "",
      "-1",
      "-1",
      "echo__PIPE__ok",
      "jump.example.com",
      "2222",
      "jump",
      "0",
      "0",
      "0",
      "_ProfileDir_\\keys\\id.ppk",
      "",
      "-1",
      "0",
      "0",
      "0",
      "",
      "1080",
      "",
      "0",
      "0",
      "1",
    ].join("%");
    const text = [
      "[Bookmarks]",
      "SubRep=Azure",
      "ImgNum=41",
      "[Bookmarks_1]",
      "SubRep=Azure\\PRE",
      "ImgNum=41",
      `sesafrazu01=#109#${sshBasic}#MobaFont%10%0%0%0%0%236,236,236%0,0,0%180,180,192%0%-1%0%%xterm%-1#0#SSH__DIEZE__comment#-1`,
    ].join("\r\n");

    const result = parseMobaXtermSessions(text, {
      targetFolder: "Imported",
      now: 3333,
    });

    expect(result.sessions).toHaveLength(1);
    expect(result.sessions[0]).toMatchObject({
      name: "sesafrazu01",
      session_type: "SSH",
      group_path: "User sessions / Imported / Azure / PRE",
      host: "sesafrazu01",
      port: 22,
      username: "azroot",
    });
    expect(result.sessions[0].auth_method).toEqual({ PrivateKey: { key_path: "_ProfileDir_\\keys\\id.ppk" } });
    expect(JSON.parse(result.sessions[0].options_json)).toMatchObject({
      x11: true,
      compression: true,
      startupCmd: "echo|ok",
      jumpHost: "jump.example.com",
      jumpPort: "2222",
      jumpUser: "jump",
      description: "SSH#comment",
    });
  });

  it("imports SFTP private key path but does not import plaintext proxy passwords", () => {
    const text = [
      "[Bookmarks]",
      "SubRep=",
      "ImgNum=42",
      "sftp-one=#140#7%sftp.example.com%22%alice%-1%0%%%0%C:\\keys\\alice.ppk%4%proxy.example.com%1080%proxy-user%proxy-secret%C:\\tmp%-1#MobaFont%10%0%0%-1%15%236,236,236%30,30,30%180,180,192%0%-1%0%%xterm%-1#0# #-1",
    ].join("\r\n");

    const result = parseMobaXtermSessions(text, { now: 4444 });

    expect(result.sessions).toHaveLength(1);
    expect(result.sessions[0]).toMatchObject({
      name: "sftp-one",
      session_type: "SFTP",
      host: "sftp.example.com",
      username: "alice",
    });
    expect(result.sessions[0].auth_method).toEqual({ PrivateKey: { key_path: "C:\\keys\\alice.ppk" } });
    expect(JSON.stringify(result.sessions[0])).not.toContain("proxy-secret");
  });

  it("exports MobaXterm bookmark sections with CRLF and skips unsupported session types", () => {
    const result = serializeMobaXtermSessions([
      session(),
      session({
        id: "rdp-1",
        name: "Desktop",
        session_type: "RDP",
        group_path: "User sessions / Production / Desktops",
        host: "rdp.example.com",
        port: 3389,
        username: "admin",
        auth_method: "None",
        options_json: "{}",
      }),
      session({
        id: "local-1",
        name: "Local",
        session_type: "LocalShell",
        group_path: "User sessions / Production",
        host: "",
        port: 0,
        username: null,
        auth_method: "None",
        options_json: "{}",
      }),
    ], "Production");

    expect(result.text).toContain("[Bookmarks]\r\nSubRep=Production\r\nImgNum=41\r\n");
    expect(result.text).toContain("[Bookmarks_1]\r\nSubRep=Production\\Desktops\r\nImgNum=41\r\n");
    expect(result.text).toContain("Prod=#109#0%prod.example.com%22%deploy");
    expect(result.text).toContain("Desktop=#91#4%rdp.example.com%3389%admin");
    expect(result.text).not.toContain("Local=");
    expect(result.skipped).toBe(1);
  });
});

describe("third-party session import parsers", () => {
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
    expect(result.warnings.join("\n")).toContain("agent authentication is not implemented");
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

  it("imports SecureCRT .ini sessions and decodes hex ports", () => {
    const result = parseSecureCrtSessions([
      'S:"Hostname"=secure.example.com',
      'S:"Username"=ops',
      'S:"Protocol Name"=SSH2',
      'D:"[SSH2] Port"=000008AE',
      'S:"Identity Filename"=C:\\keys\\ops.pem',
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
});

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
