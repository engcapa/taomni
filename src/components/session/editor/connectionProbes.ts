import { testSshConnection, testProxyConnection, dbTestConnection, hbaseTestConnection } from "../../../lib/ipc";
import type { DbConnectInfo, HBaseConnectInfo } from "../../../types";
import { toNetworkSettingsPayload, type NetworkSettings as NetworkSettingsValue } from "../../../lib/networkSettings";
import { formatUnknownError } from "../../../lib/appDialogs";
import type { SessionConfig } from "../../../lib/ipc";
import { type Proto, DEFAULT_PORTS } from "./sessionPolicy";



export interface HandleTestConnectionContext {
  host: string;
  username: string;
  presentTestOutcome: (ok: boolean, rawMessage: string) => void;
  t: import("../../../lib/i18n").TranslateFn;
  password: string;
  passwordRef: string;
  authMethod: "Password" | "Agent" | "None" | "PrivateKey";
  setTesting: import("react").Dispatch<import("react").SetStateAction<boolean>>;
  setTestResult: import("react").Dispatch<import("react").SetStateAction<{ ok: boolean; msg: string; } | null>>;
  keyPath: string;
  port: string;
  networkSettings: NetworkSettingsValue;
}


export function createHandleTestConnection(controllerContext: HandleTestConnectionContext): () => Promise<void> {
  return async () => {
    if (!controllerContext.host || !controllerContext.username) {
      controllerContext.presentTestOutcome(false, controllerContext.t("sessionEditor2.testHostUserRequired"));
      return;
    }
    const passwordAuthData = controllerContext.password || controllerContext.passwordRef;
    if (controllerContext.authMethod === "Password" && !passwordAuthData) {
      controllerContext.presentTestOutcome(false, controllerContext.t("sessionEditor2.testEnterPassword"));
      return;
    }
    controllerContext.setTesting(true);
    controllerContext.setTestResult(null);
    try {
      let authData: string | null = null;
      if (controllerContext.authMethod === "Password") authData = passwordAuthData;
      else if (controllerContext.authMethod === "PrivateKey")
        authData = controllerContext.keyPath || "~/.ssh/id_ed25519";
      const msg = await testSshConnection(
        controllerContext.host,
        parseInt(controllerContext.port) || 22,
        controllerContext.username,
        controllerContext.authMethod,
        authData,
        JSON.stringify(toNetworkSettingsPayload(controllerContext.networkSettings)),
      );
      controllerContext.presentTestOutcome(true, msg);
    } catch (err) {
      controllerContext.presentTestOutcome(false, formatUnknownError(err));
    } finally {
      controllerContext.setTesting(false);
    }
  };
}



export interface BuildDbConnectInfoContext {
  session: SessionConfig | undefined;
  proto: Proto;
  host: string;
  port: string;
  username: string;
  password: string;
  passwordRef: string;
  dbCatalog: string;
  dbDatabase: string;
  dbSsl: boolean;
  dbTimeout: string;
  dbHttpPort: string;
  dbChProtocol: string;
  dbPrestoDialect: string;
  dbRedisIndex: string;
  networkSettings: NetworkSettingsValue;
}


export function createBuildDbConnectInfo(controllerContext: BuildDbConnectInfoContext): () => DbConnectInfo {
  return (): DbConnectInfo => ({
    sessionId: controllerContext.session?.id ?? "db-editor-test",
    engine: controllerContext.proto as DbConnectInfo["engine"],
    host: controllerContext.host,
    port: parseInt(controllerContext.port) || DEFAULT_PORTS[controllerContext.proto] || 0,
    username: controllerContext.username || null,
    password: controllerContext.password || controllerContext.passwordRef || undefined,
    catalog: controllerContext.proto === "Presto" ? controllerContext.dbCatalog || null : null,
    database: controllerContext.dbDatabase || null,
    ssl: controllerContext.dbSsl,
    timeoutSecs: parseInt(controllerContext.dbTimeout) || null,
    httpPort: controllerContext.proto === "ClickHouse" ? parseInt(controllerContext.dbHttpPort) || 8123 : null,
    protocol: controllerContext.proto === "ClickHouse" ? controllerContext.dbChProtocol.toLowerCase() : null,
    prestoDialect:
      controllerContext.proto === "Presto"
        ? (controllerContext.dbPrestoDialect.toLowerCase() === "trino" ? "trino" : "presto")
        : null,
    dbIndex: controllerContext.proto === "Redis" ? parseInt(controllerContext.dbRedisIndex) || 0 : null,
    // Route the test probe through the same proxy / SSH jump host the saved
    // connection uses. Only attach when a proxy/jump is actually selected so a
    // direct connection skips the backend loopback forwarder entirely (mirrors
    // sessionToDbConnectInfo in MainLayout).
    networkSettings:
      controllerContext.networkSettings.proxyKind !== "none"
        ? toNetworkSettingsPayload(controllerContext.networkSettings)
        : null,
  });
}



export interface BuildHBaseConnectInfoContext {
  session: SessionConfig | undefined;
  host: string;
  port: string;
  username: string;
  password: string;
  passwordRef: string;
  dbSsl: boolean;
  dbTimeout: string;
  hbaseRestPath: string;
  hbaseNamespace: string;
  hbaseConnectionMode: string;
  hbaseZkQuorum: string;
  hbaseZkRoot: string;
  hbaseEffectiveUser: string;
  hbaseAuthMethod: string;
  hbaseServicePrincipal: string;
  hbasePrincipal: string;
  hbaseKeytabPath: string;
  hbaseKrb5ConfPath: string;
  hbaseSitePath: string;
}


export function createBuildHBaseConnectInfo(controllerContext: BuildHBaseConnectInfoContext): () => HBaseConnectInfo {
  return (): HBaseConnectInfo => ({
    sessionId: controllerContext.session?.id ?? "hbase-editor-test",
    host: controllerContext.host,
    port: parseInt(controllerContext.port) || DEFAULT_PORTS.HBaseShell,
    username: controllerContext.username || null,
    password: controllerContext.password || controllerContext.passwordRef || undefined,
    ssl: controllerContext.dbSsl,
    timeoutSecs: parseInt(controllerContext.dbTimeout) || null,
    restPath: controllerContext.hbaseRestPath || null,
    namespace: controllerContext.hbaseNamespace || null,
    connectionMode:
      controllerContext.hbaseConnectionMode === "rest"
        ? "rest"
        : controllerContext.hbaseConnectionMode === "thrift"
          ? "thrift"
          : "native",
    zkQuorum: controllerContext.hbaseZkQuorum || null,
    zkRoot: controllerContext.hbaseZkRoot || null,
    effectiveUser: controllerContext.hbaseEffectiveUser || null,
    authMethod: controllerContext.hbaseAuthMethod === "kerberos" ? "kerberos" : "simple",
    servicePrincipal: controllerContext.hbaseServicePrincipal || null,
    principal: controllerContext.hbasePrincipal || null,
    keytabPath: controllerContext.hbaseKeytabPath || null,
    krb5ConfPath: controllerContext.hbaseKrb5ConfPath || null,
    hbaseSitePath: controllerContext.hbaseSitePath || null,
  });
}



export interface HandleTestDbConnectionContext {
  host: string;
  presentTestOutcome: (ok: boolean, rawMessage: string) => void;
  t: import("../../../lib/i18n").TranslateFn;
  proto: Proto;
  dbCatalog: string;
  setTesting: import("react").Dispatch<import("react").SetStateAction<boolean>>;
  setTestResult: import("react").Dispatch<import("react").SetStateAction<{ ok: boolean; msg: string; } | null>>;
  buildDbConnectInfo: () => DbConnectInfo;
}


export function createHandleTestDbConnection(controllerContext: HandleTestDbConnectionContext): () => Promise<void> {
  return async () => {
    if (!controllerContext.host) {
      controllerContext.presentTestOutcome(false, controllerContext.t("sessionEditor2.errHostRequired"));
      return;
    }
    if (controllerContext.proto === "Presto" && !controllerContext.dbCatalog.trim()) {
      controllerContext.presentTestOutcome(false, "Presto catalog is required.");
      return;
    }
    controllerContext.setTesting(true);
    controllerContext.setTestResult(null);
    try {
      const msg = await dbTestConnection(controllerContext.buildDbConnectInfo());
      controllerContext.presentTestOutcome(true, msg);
    } catch (err) {
      controllerContext.presentTestOutcome(false, formatUnknownError(err));
    } finally {
      controllerContext.setTesting(false);
    }
  };
}



export interface HandleTestHBaseConnectionContext {
  hbaseConnectionMode: string;
  host: string;
  presentTestOutcome: (ok: boolean, rawMessage: string) => void;
  hbaseSitePath: string;
  hbaseZkQuorum: string;
  setTesting: import("react").Dispatch<import("react").SetStateAction<boolean>>;
  setTestResult: import("react").Dispatch<import("react").SetStateAction<{ ok: boolean; msg: string; } | null>>;
  buildHBaseConnectInfo: () => HBaseConnectInfo;
}


export function createHandleTestHBaseConnection(controllerContext: HandleTestHBaseConnectionContext): () => Promise<void> {
  return async () => {
    // Mirror the save-path validation: REST/Thrift need a host; native needs a
    // ZK quorum, an hbase-site.xml, or a host (host/port hidden in native mode).
    if ((controllerContext.hbaseConnectionMode === "rest" || controllerContext.hbaseConnectionMode === "thrift") && !controllerContext.host.trim()) {
      controllerContext.presentTestOutcome(
        false,
        controllerContext.hbaseConnectionMode === "thrift"
          ? "HBase Thrift host is required."
          : "HBase REST host is required.",
      );
      return;
    }
    if (
      controllerContext.hbaseConnectionMode === "native" &&
      !controllerContext.hbaseSitePath.trim() &&
      !controllerContext.hbaseZkQuorum.trim() &&
      !controllerContext.host.trim()
    ) {
      controllerContext.presentTestOutcome(
        false,
        "HBase ZooKeeper quorum, HBase-site.xml, or Remote host is required.",
      );
      return;
    }
    controllerContext.setTesting(true);
    controllerContext.setTestResult(null);
    try {
      const msg = await hbaseTestConnection(controllerContext.buildHBaseConnectInfo());
      controllerContext.presentTestOutcome(true, msg);
    } catch (err) {
      controllerContext.presentTestOutcome(false, formatUnknownError(err));
    } finally {
      controllerContext.setTesting(false);
    }
  };
}



export interface HandleTestProxyConnectionContext {
  host: string;
  presentTestOutcome: (ok: boolean, rawMessage: string) => void;
  t: import("../../../lib/i18n").TranslateFn;
  setTesting: import("react").Dispatch<import("react").SetStateAction<boolean>>;
  setTestResult: import("react").Dispatch<import("react").SetStateAction<{ ok: boolean; msg: string; } | null>>;
  proxyTestUrl: string;
  proxyKind: "http" | "socks5";
  port: string;
  username: string;
  password: string;
  passwordRef: string;
}


export function createHandleTestProxyConnection(controllerContext: HandleTestProxyConnectionContext): () => Promise<void> {
  return async () => {
    if (!controllerContext.host) {
      controllerContext.presentTestOutcome(false, controllerContext.t("sessionEditor2.proxyHostRequired"));
      return;
    }
    controllerContext.setTesting(true);
    controllerContext.setTestResult(null);
    try {
      const [testHost, testPortStr] = (controllerContext.proxyTestUrl || "www.google.com:443").split(":");
      const testPort = parseInt(testPortStr) || 443;
      const msg = await testProxyConnection(
        controllerContext.proxyKind,
        controllerContext.host,
        parseInt(controllerContext.port) || 3128,
        controllerContext.username || "",
        controllerContext.password || controllerContext.passwordRef || "",
        testHost,
        testPort,
      );
      controllerContext.presentTestOutcome(true, msg);
    } catch (err) {
      controllerContext.presentTestOutcome(false, formatUnknownError(err));
    } finally {
      controllerContext.setTesting(false);
    }
  };
}
