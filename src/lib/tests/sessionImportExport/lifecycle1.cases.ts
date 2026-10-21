import { describe, expect, it } from "vitest";
import { parseCsvSessions, parseTaomniSessions, serializeCsvSessions, serializeCsvSessionTemplate, serializeTaomniSessions } from "../../sessionImportExport";
import { session } from "./harness";

export function registersessionImportExportLifecycle1Cases() {

  describe("Taomni session import/export", () => {
    it("round trips safe session fields and strips local log paths", () => {
      const exported = serializeTaomniSessions([session()], "Production");
      const parsed = JSON.parse(exported.text) as { sessions: Array<{ folder_path: string | null; options: Record<string, unknown>; }>; };

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
      const parsed = JSON.parse(exported.text) as { format: string; };
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
          dbPrestoDialect: "trino",
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
        dbPrestoDialect: "trino",
        passwordRef: "vault:db-presto",
      });
    });

    it("round-trips planned client session types", () => {
      const exported = serializeTaomniSessions([
        session({ id: "rlogin-1", name: "Legacy host", session_type: "Rlogin", port: 513 }),
        session({ id: "mosh-1", name: "Roaming shell", session_type: "Mosh", port: 60001 }),
        session({ id: "browser-1", name: "Docs", session_type: "Browser", port: 0 }),
      ], null);

      const imported = parseTaomniSessions(exported.text, { now: 4444 });

      expect(imported.warnings).toEqual([]);
      expect(imported.sessions.map((item) => item.session_type)).toEqual(["Rlogin", "Mosh", "Browser"]);
      expect(imported.sessions.map((item) => item.port)).toEqual([513, 60001, 0]);
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
      expect(result.text).toContain('"Prod, primary",SSH,prod.example.com,22,"deploy""ops",private-key,C:\\keys\\deploy.ppk,,Web');

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
      expect(imported.sessions[0].auth_method).toEqual({ PrivateKey: { key_path: "C:\\keys\\deploy.ppk" } });
    });

    it("imports SSH sessions from the fixed CSV template fields", () => {
      const result = parseCsvSessions([
        "name,ip,username,auth_method,private_key_path,group_path,description,startup_cmd,jump_host,jump_user,jump_key_path,compression,x11,agent_forward",
        "Legacy SecureCRT,10.0.0.12,ops,private-key,C:\\keys\\ops.pem,Imported / SecureCRT,old appliance,tmux a,bastion.example.com,jump,C:\\keys\\jump.pem,yes,no,true",
      ].join("\n"), {
        targetFolder: "CSV",
        now: 5566,
      });

      expect(result.warnings).toEqual([]);
      expect(result.sessions).toHaveLength(1);
      expect(result.sessions[0]).toMatchObject({
        name: "Legacy SecureCRT",
        session_type: "SSH",
        group_path: "User sessions / CSV / Imported / SecureCRT",
        host: "10.0.0.12",
        port: 22,
        username: "ops",
        auth_method: { PrivateKey: { key_path: "C:\\keys\\ops.pem" } },
      });
      expect(JSON.parse(result.sessions[0].options_json)).toMatchObject({
        description: "old appliance",
        startupCmd: "tmux a",
        compression: true,
        x11: false,
        agentForward: true,
        jumpHost: "bastion.example.com",
        jumpUser: "jump",
        jumpPort: "22",
        networkSettings: {
          proxyKind: "ssh-tunnel",
          jumpHost: "bastion.example.com",
          jumpUser: "jump",
          jumpAuthKind: "PrivateKey",
          jumpKeyPath: "C:\\keys\\jump.pem",
        },
      });
    });

    it("imports CSV passwords as vault secrets for password-auth sessions", () => {
      const result = parseCsvSessions([
        "name,host,port,username,auth_method,password,group_path",
        "Password Host,192.168.1.20,2202,root,password,secret123,Ops",
      ].join("\n"), {
        targetFolder: "CSV",
        now: 5577,
      });

      expect(result.sessions).toHaveLength(1);
      expect(result.sessions[0]).toMatchObject({
        name: "Password Host",
        session_type: "SSH",
        group_path: "User sessions / CSV / Ops",
        host: "192.168.1.20",
        port: 2202,
        username: "root",
        auth_method: "Password",
      });
      expect(result.secrets).toEqual([{
        sessionId: result.sessions[0].id,
        kind: "password",
        label: "root@192.168.1.20:2202",
        value: "secret123",
      }]);
    });

    it("does not treat CSV passwords as private-key passphrases", () => {
      const result = parseCsvSessions([
        "name,host,username,private_key_path,password",
        "Key Host,192.168.1.21,deploy,C:\\keys\\deploy.pem,not-a-key-passphrase",
      ].join("\n"), { now: 5578 });

      expect(result.sessions).toHaveLength(1);
      expect(result.sessions[0].auth_method).toEqual({ PrivateKey: { key_path: "C:\\keys\\deploy.pem" } });
      expect(result.secrets).toEqual([]);
      expect(result.warnings.join("\n")).toContain("uses private-key authentication");
    });

    it("exports a header-only CSV import template", () => {
      const result = serializeCsvSessionTemplate();

      expect(result.filename).toBe("taomni-ssh-session-import-template.csv");
      expect(result.mimeType).toBe("text/csv");
      expect(result.text).toBe(
        "name,session_type,host,port,username,auth_method,private_key_path,password,group_path,description,tags,startup_cmd,jump_host,jump_port,jump_user,jump_key_path,compression,x11,agent_forward\r\n",
      );
      expect(parseCsvSessions(result.text).sessions).toHaveLength(0);
    });
  });
}
