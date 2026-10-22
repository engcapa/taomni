import { invoke } from "@tauri-apps/api/core";
import type { HBaseConnectInfo } from "../../types";
import { withVaultLockedNotice } from "./vault";

// --- HBase shell client (JVM-free HBase REST/Stargate) ---

export function toHBaseConfigPayload(info: HBaseConnectInfo): Record<string, unknown> {
  return {
    host: info.host,
    port: info.port,
    username: info.username ?? null,
    password: info.password ?? null,
    ssl: info.ssl ?? false,
    timeoutSecs: info.timeoutSecs ?? null,
    restPath: info.restPath ?? null,
    namespace: info.namespace ?? null,
    connectionMode: info.connectionMode ?? null,
    zkQuorum: info.zkQuorum ?? null,
    zkRoot: info.zkRoot ?? null,
    effectiveUser: info.effectiveUser ?? null,
    authMethod: info.authMethod ?? null,
    servicePrincipal: info.servicePrincipal ?? null,
    principal: info.principal ?? null,
    keytabPath: info.keytabPath ?? null,
    krb5ConfPath: info.krb5ConfPath ?? null,
    hbaseSitePath: info.hbaseSitePath ?? null,
  };
}

export interface HBaseConnectResult {
  ok: boolean;
}

export interface HBaseTableInfo {
  name: string;
}

export interface HBaseColumnFamily {
  name: string;
  attributes: Record<string, string>;
}

export interface HBaseTableSchema {
  name: string;
  columnFamilies: HBaseColumnFamily[];
}

export interface HBaseShellResult {
  command: string;
  message: string;
  columns: string[];
  rows: string[][];
  warnings: string[];
  durationMs: number;
}

export async function hbaseConnect(info: HBaseConnectInfo): Promise<HBaseConnectResult> {
  return withVaultLockedNotice(() =>
    invoke<HBaseConnectResult>("hbase_connect", {
      sessionId: info.sessionId,
      config: toHBaseConfigPayload(info),
    }),
  );
}

export async function hbasePing(sessionId: string): Promise<string> {
  return invoke<string>("hbase_ping", { sessionId });
}

export async function hbaseTestConnection(info: HBaseConnectInfo): Promise<string> {
  const probeId = `hbase-test-${globalThis.crypto?.randomUUID?.() ?? Date.now()}`;
  const probe: HBaseConnectInfo = { ...info, sessionId: probeId };
  await hbaseConnect(probe);
  try {
    return await hbasePing(probeId);
  } finally {
    await hbaseDisconnect(probeId).catch(() => undefined);
  }
}

export async function hbaseDisconnect(sessionId: string): Promise<void> {
  return invoke("hbase_disconnect", { sessionId });
}

export async function hbaseCancel(sessionId: string): Promise<void> {
  return invoke("hbase_cancel", { sessionId });
}

export async function hbaseListTables(sessionId: string): Promise<HBaseTableInfo[]> {
  return invoke<HBaseTableInfo[]>("hbase_list_tables", { sessionId });
}

export async function hbaseDescribeTable(
  sessionId: string,
  table: string,
): Promise<HBaseTableSchema> {
  return invoke<HBaseTableSchema>("hbase_describe_table", { sessionId, table });
}

export async function hbaseExecute(
  sessionId: string,
  command: string,
): Promise<HBaseShellResult> {
  return invoke<HBaseShellResult>("hbase_execute", { sessionId, command });
}

export async function hbaseParseSiteXml(path: string): Promise<Record<string, string>> {
  return invoke<Record<string, string>>("hbase_parse_site_xml", { path });
}

export async function hbaseParseKeytabPrincipal(path: string): Promise<string> {
  return invoke<string>("hbase_parse_keytab_principal", { path });
}
