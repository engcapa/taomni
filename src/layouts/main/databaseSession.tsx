import type { DbConnectInfo, HBaseConnectInfo } from "../../types";
import { type SessionConfig } from "../../lib/ipc";
import { parseSessionOptions } from "../../lib/terminalProfile";
import { getSessionNetworkSettings, toNetworkSettingsPayload } from "../../lib/networkSettings";


/**
 * Build a {@link DbConnectInfo} from a saved DB session. Engine-specific
 * options (ClickHouse HTTP port / protocol, Presto catalog / dialect, Redis
 * DB index, SSL, timeout, default database) live in `options_json` under the
 * `db*` keys the session editor writes. `password` is the resolved credential
 * (plaintext or a `vault:` reference) the connect path already worked out.
 */
export function sessionToDbConnectInfo(session: SessionConfig, password?: string): DbConnectInfo {
  const opts = parseSessionOptions(session.options_json);
  const str = (key: string, fallback = ""): string =>
    typeof opts[key] === "string" ? (opts[key] as string) : fallback;
  const num = (key: string): number | null => {
    const raw = opts[key];
    const n = typeof raw === "number" ? raw : parseInt(String(raw ?? ""), 10);
    return Number.isFinite(n) ? n : null;
  };
  const engine = session.session_type as DbConnectInfo["engine"];
  // Only attach network settings when a proxy / SSH jump host is actually
  // selected; a direct connection sends none so the backend skips the
  // loopback forwarder entirely.
  const ns = getSessionNetworkSettings(session.options_json);
  const networkSettings = ns.proxyKind !== "none" ? toNetworkSettingsPayload(ns) : null;
  const prestoDialectRaw = str("dbPrestoDialect", "presto").toLowerCase();
  return {
    sessionId: session.id,
    workspaceSessionId: session.id,
    engine,
    host: session.host,
    port: session.port,
    username: session.username,
    password,
    catalog: engine === "Presto" ? str("dbCatalog") || null : null,
    database: str("dbDatabase") || null,
    ssl: opts.dbSsl === true,
    timeoutSecs: num("dbTimeout"),
    httpPort: engine === "ClickHouse" ? (num("dbHttpPort") ?? 8123) : null,
    protocol: engine === "ClickHouse" ? str("dbChProtocol", "HTTP").toLowerCase() : null,
    prestoDialect:
      engine === "Presto"
        ? (prestoDialectRaw === "trino" ? "trino" : "presto")
        : null,
    dbIndex: engine === "Redis" ? (num("dbRedisIndex") ?? 0) : null,
    networkSettings,
  };
}


export function sessionToHBaseConnectInfo(session: SessionConfig, password?: string): HBaseConnectInfo {
  const opts = parseSessionOptions(session.options_json);
  const str = (key: string, fallback = ""): string =>
    typeof opts[key] === "string" ? (opts[key] as string) : fallback;
  const num = (key: string): number | null => {
    const raw = opts[key];
    const n = typeof raw === "number" ? raw : parseInt(String(raw ?? ""), 10);
    return Number.isFinite(n) ? n : null;
  };
  return {
    sessionId: session.id,
    workspaceSessionId: session.id,
    host: session.host,
    port: session.port,
    username: session.username,
    password,
    ssl: opts.dbSsl === true,
    timeoutSecs: num("dbTimeout"),
    restPath: str("hbaseRestPath") || null,
    namespace: str("hbaseNamespace") || null,
    connectionMode:
      str("hbaseConnectionMode") === "rest"
        ? "rest"
        : str("hbaseConnectionMode") === "thrift"
          ? "thrift"
          : "native",
    zkQuorum: str("hbaseZkQuorum") || null,
    zkRoot: str("hbaseZkRoot") || null,
    effectiveUser: str("hbaseEffectiveUser") || null,
    authMethod: (str("hbaseAuthMethod") as any) || null,
    servicePrincipal: str("hbaseServicePrincipal") || null,
    principal: str("hbasePrincipal") || null,
    keytabPath: str("hbaseKeytabPath") || null,
    krb5ConfPath: str("hbaseKrb5ConfPath") || null,
    hbaseSitePath: str("hbaseSitePath") || null,
  };
}
