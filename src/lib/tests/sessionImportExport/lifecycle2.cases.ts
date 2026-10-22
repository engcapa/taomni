import { describe, expect, it } from "vitest";
import { parseDbeaverSessions, parseNavicatSessions } from "../../sessionImportExport";

export function registersessionImportExportLifecycle2Cases() {

  describe("DBeaver session import", () => {
    it("maps supported DBeaver database drivers to Taomni DB session types", () => {
      const text = JSON.stringify({
        folders: {
          prod: { name: "Production" },
        },
        connections: {
          maria: {
            provider: "mariadb",
            driver: "mariadb",
            name: "Maria Prod",
            folder: "prod",
            "save-password": true,
            configuration: {
              host: "db.example.com",
              port: "3307",
              database: "app",
              user: "appuser",
              password: "secret",
              properties: { useSSL: "true" },
            },
          },
          mssql: {
            driver: "Microsoft SQL Server",
            name: "Warehouse",
            configuration: {
              url: "jdbc:jtds:sqlserver://sql.example.com:1444/warehouse;encrypt=true;user=sa",
            },
          },
          starrocks: {
            driver: "StarRocks",
            name: "Lake Analytics",
            configuration: {
              url: "jdbc:mysql://sr.example.com:9030/warehouse",
              user: "reader",
            },
          },
          pg: {
            driver: "postgresql",
            name: "Analytics",
            configuration: {
              url: "jdbc:postgresql://pg.example.com:5433/analytics?sslmode=require",
              user: "reporter",
            },
          },
          clickhouse: {
            driver: "clickhouse",
            name: "Events",
            configuration: {
              url: "jdbc:clickhouse://ch.example.com:8123/events?ssl=true",
              user: "reader",
            },
          },
          trino: {
            driver: "trino",
            name: "Lakehouse",
            configuration: {
              url: "jdbc:trino://trino.example.com:8443/hive/sales?SSL=true",
              user: "analyst",
            },
          },
          presto: {
            driver: "presto",
            name: "Legacy Presto",
            configuration: {
              url: "jdbc:presto://presto.example.com:8080/hive/default",
              user: "presto_user",
            },
          },
          redis: {
            driver: "redis",
            name: "Cache",
            configuration: {
              url: "redis://:redis-pass@redis.example.com:6380/2",
            },
          },
          panwei: {
            driver: "panweidb",
            name: "PanWei Warehouse",
            configuration: {
              url: "jdbc:postgresql://pw.example.com:5432/pwdb?sslmode=disable",
              user: "pwuser",
            },
          },
          oracle: {
            driver: "oracle",
            name: "Billing Oracle",
            configuration: {
              url: "jdbc:oracle:thin:@//oracle.example.com:1522/ORCLPDB1",
              user: "billing",
            },
          },
        },
      });

      const result = parseDbeaverSessions(text, { targetFolder: "Imported", now: 7777 });

      expect(result.sessions.map((s) => s.session_type)).toEqual([
        "MySQL",
        "SQLServer",
        "StarRocks",
        "PostgreSQL",
        "ClickHouse",
        "Presto",
        "Presto",
        "Redis",
        "PanWeiDB",
        "Oracle",
      ]);
      expect(result.skipped).toBe(0);
      expect(result.secrets).toHaveLength(2);
      expect(result.sessions[0]).toMatchObject({
        name: "Maria Prod",
        group_path: "User sessions / Imported / DBeaver / Production",
        host: "db.example.com",
        port: 3307,
        username: "appuser",
        created_at: 7777,
        updated_at: 7777,
      });
      expect(JSON.parse(result.sessions[0].options_json)).toMatchObject({
        dbDatabase: "app",
        dbSsl: true,
        dbTimeout: "15",
      });
      expect(result.sessions[2]).toMatchObject({
        name: "Lake Analytics",
        session_type: "StarRocks",
        host: "sr.example.com",
        port: 9030,
        username: "reader",
      });
      expect(JSON.parse(result.sessions[2].options_json)).toMatchObject({
        dbDatabase: "warehouse",
        dbSsl: false,
        dbTimeout: "15",
      });
      expect(result.sessions[1]).toMatchObject({
        name: "Warehouse",
        session_type: "SQLServer",
        host: "sql.example.com",
        port: 1444,
        username: "sa",
      });
      expect(JSON.parse(result.sessions[1].options_json)).toMatchObject({
        dbDatabase: "warehouse",
        dbSsl: true,
      });
      expect(JSON.parse(result.sessions[3].options_json)).toMatchObject({
        dbDatabase: "analytics",
        dbSsl: true,
      });
      expect(result.sessions[4]).toMatchObject({
        name: "Events",
        session_type: "ClickHouse",
        host: "ch.example.com",
        port: 9000,
        username: "reader",
      });
      expect(JSON.parse(result.sessions[4].options_json)).toMatchObject({
        dbDatabase: "events",
        dbHttpPort: "8123",
        dbChProtocol: "HTTP",
        dbSsl: true,
      });
      expect(JSON.parse(result.sessions[5].options_json)).toMatchObject({
        dbCatalog: "hive",
        dbDatabase: "sales",
        dbSsl: true,
        // jdbc:trino:// + driver "trino" must default to the Trino header dialect.
        dbPrestoDialect: "trino",
      });
      expect(JSON.parse(result.sessions[6].options_json)).toMatchObject({
        dbCatalog: "hive",
        dbDatabase: "default",
        // jdbc:presto:// stays on the Presto header dialect.
        dbPrestoDialect: "presto",
      });
      expect(JSON.parse(result.sessions[7].options_json)).toMatchObject({
        dbRedisIndex: "2",
      });
      expect(result.sessions[8]).toMatchObject({
        name: "PanWei Warehouse",
        session_type: "PanWeiDB",
        host: "pw.example.com",
        port: 5432,
        username: "pwuser",
      });
      expect(JSON.parse(result.sessions[8].options_json)).toMatchObject({
        dbDatabase: "pwdb",
        dbSsl: false,
      });
      expect(result.sessions[9]).toMatchObject({
        name: "Billing Oracle",
        session_type: "Oracle",
        host: "oracle.example.com",
        port: 1522,
        username: "billing",
      });
      expect(JSON.parse(result.sessions[9].options_json)).toMatchObject({
        dbDatabase: "ORCLPDB1",
        dbSsl: false,
      });
    });

    it("reads DBeaver credentials from auth-properties and authProperties", () => {
      const text = JSON.stringify({
        connections: {
          hyphen: {
            driver: "postgresql",
            name: "Hyphen Auth",
            configuration: {
              host: "pg-auth.example.com",
              port: "5432",
              "auth-properties": {
                user: "pg_auth_user",
                password: "pg-auth-pass",
              },
            },
          },
          camel: {
            driver: "mysql",
            name: "Camel Auth",
            configuration: {
              host: "mysql-auth.example.com",
              authProperties: {
                username: "mysql_auth_user",
                password: "mysql-auth-pass",
              },
            },
          },
        },
      });

      const result = parseDbeaverSessions(text, { now: 8888 });

      expect(result.sessions).toHaveLength(2);
      expect(result.sessions[0]).toMatchObject({
        name: "Hyphen Auth",
        session_type: "PostgreSQL",
        host: "pg-auth.example.com",
        port: 5432,
        username: "pg_auth_user",
      });
      expect(result.sessions[1]).toMatchObject({
        name: "Camel Auth",
        session_type: "MySQL",
        host: "mysql-auth.example.com",
        port: 3306,
        username: "mysql_auth_user",
      });
      expect(result.secrets.map((secret) => ({
        sessionId: secret.sessionId,
        kind: secret.kind,
        value: secret.value,
      }))).toEqual([
        {
          sessionId: result.sessions[0].id,
          kind: "password",
          value: "pg-auth-pass",
        },
        {
          sessionId: result.sessions[1].id,
          kind: "password",
          value: "mysql-auth-pass",
        },
      ]);
    });

    it("merges DBeaver credentials-config entries by connection id", () => {
      const text = JSON.stringify({
        connections: {
          direct: {
            driver: "mysql",
            name: "Direct Secure",
            "save-password": true,
            configuration: {
              host: "direct.example.com",
            },
          },
          sectionOnly: {
            driver: "postgresql",
            name: "Section Secure",
            "save-password": true,
            configuration: {
              host: "section.example.com",
            },
          },
        },
      });

      const result = parseDbeaverSessions(text, {
        now: 9999,
        dbeaverCredentials: {
          direct: {
            user: "direct_user",
            password: "direct-pass",
          },
          sectionOnly: {
            sections: {
              "#connection": {
                user: "section_user",
                password: "section-pass",
              },
            },
          },
        },
      });

      expect(result.sessions).toHaveLength(2);
      expect(result.sessions[0]).toMatchObject({
        name: "Direct Secure",
        session_type: "MySQL",
        host: "direct.example.com",
        username: "direct_user",
      });
      expect(result.sessions[1]).toMatchObject({
        name: "Section Secure",
        session_type: "PostgreSQL",
        host: "section.example.com",
        username: "section_user",
      });
      expect(result.secrets.map((secret) => ({
        sessionId: secret.sessionId,
        kind: secret.kind,
        value: secret.value,
      }))).toEqual([
        {
          sessionId: result.sessions[0].id,
          kind: "password",
          value: "direct-pass",
        },
        {
          sessionId: result.sessions[1].id,
          kind: "password",
          value: "section-pass",
        },
      ]);
      expect(result.warnings).toEqual([]);
    });
  });

  describe("Navicat session import", () => {
    it("imports Navicat .ncx database connections and decrypts saved passwords", async () => {
      const text = [
        '<?xml version="1.0" encoding="UTF-8"?>',
        "<Connections>",
        '  <Group Name="Production">',
        '    <Connection ConnectionName="Prod MySQL" ConnType="MYSQL" Host="mysql.example.com" Port="3307" UserName="app" Database="appdb" Ssl="true" Password="4B1C473F8F0856717EF48AA51DA9855B" />',
        '    <Connection ConnectionName="StarRocks FE" ConnType="STARROCKS" Host="sr.example.com" UserName="reader" Database="warehouse" />',
        "  </Group>",
        '  <Connection ConnectionName="Cache" ConnType="REDIS" Host="redis.example.com" Port="6380" UserName="default" Database="2" />',
        '  <Connection ConnectionName="Billing Oracle" ConnType="ORACLE" Host="oracle.example.com" Port="1521" UserName="billing" Database="ORCLPDB1" />',
        "</Connections>",
      ].join("\n");

      const result = await parseNavicatSessions(text, { targetFolder: "Imported", now: 6060 });

      expect(result.sessions.map((s) => s.session_type)).toEqual(["MySQL", "StarRocks", "Redis", "Oracle"]);
      expect(result.skipped).toBe(0);
      expect(result.sessions[0]).toMatchObject({
        name: "Prod MySQL",
        group_path: "User sessions / Imported / Navicat / Production",
        host: "mysql.example.com",
        port: 3307,
        username: "app",
        auth_method: "Password",
        created_at: 6060,
        updated_at: 6060,
      });
      expect(JSON.parse(result.sessions[0].options_json)).toMatchObject({
        description: "Imported from Navicat .ncx",
        dbDatabase: "appdb",
        dbSsl: true,
        dbTimeout: "15",
      });
      expect(result.sessions[1]).toMatchObject({
        name: "StarRocks FE",
        session_type: "StarRocks",
        host: "sr.example.com",
        port: 9030,
        username: "reader",
      });
      expect(JSON.parse(result.sessions[1].options_json)).toMatchObject({
        dbDatabase: "warehouse",
        dbSsl: false,
        dbTimeout: "15",
      });
      expect(JSON.parse(result.sessions[2].options_json)).toMatchObject({
        dbRedisIndex: "2",
      });
      expect(result.sessions[3]).toMatchObject({
        name: "Billing Oracle",
        session_type: "Oracle",
        host: "oracle.example.com",
        port: 1521,
        username: "billing",
      });
      expect(JSON.parse(result.sessions[3].options_json)).toMatchObject({
        dbDatabase: "ORCLPDB1",
        dbSsl: false,
        dbTimeout: "15",
      });
      expect(result.secrets).toEqual([
        {
          sessionId: result.sessions[0].id,
          kind: "password",
          label: "Prod MySQL (mysql.example.com:3307)",
          value: "secret123",
          attachment: "session",
        },
      ]);
      expect(result.warnings).not.toContain('Skipped Navicat connection "Billing Oracle" because its database type is not supported by Taomni.');
    });

    it("keeps Navicat Pwd_2 local credential recovery as a phase 2 warning", async () => {
      const text = '<Connections><Connection ConnectionName="Local MySQL" ConnType="MYSQL" Host="local.example.com" UserName="app" Pwd_2="encrypted-local-credential" /></Connections>';

      const result = await parseNavicatSessions(text, { now: 6061 });

      expect(result.sessions).toHaveLength(1);
      expect(result.secrets).toEqual([]);
      expect(result.warnings).toEqual([
        'Navicat connection "Local MySQL" uses the newer Pwd_2 credential format; local config password recovery is planned for phase 2.',
      ]);
    });
  });
}
