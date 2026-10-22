import { invoke } from "@tauri-apps/api/core";

// --- Redis ---

export interface RedisKeyEntry {
  key: string;
  type: "string" | "hash" | "list" | "set" | "zset" | "stream" | "none";
  /** TTL seconds: -1 persistent, -2 missing, else seconds remaining. */
  ttl: number;
}

export interface RedisScanPage {
  cursor: string;
  keys: RedisKeyEntry[];
}

export interface RedisValue {
  kind: "string" | "hash" | "list" | "set" | "zset" | "stream" | "none";
  /** Shape depends on kind — see Rust `RedisValue` doc. */
  value: unknown;
  ttl: number;
  encoding: string | null;
  memoryUsage: number | null;
}

export async function redisListKeys(
  sessionId: string,
  pattern: string,
  cursor: string,
  count: number,
): Promise<RedisScanPage> {
  return invoke<RedisScanPage>("redis_list_keys", {
    sessionId,
    pattern,
    cursor,
    count,
  });
}

export async function redisGetKey(sessionId: string, key: string): Promise<RedisValue> {
  return invoke<RedisValue>("redis_get_key", { sessionId, key });
}

export async function redisSetKey(
  sessionId: string,
  key: string,
  kind: string,
  value: unknown,
  ttl?: number | null,
): Promise<void> {
  return invoke("redis_set_key", { sessionId, key, kind, value, ttl: ttl ?? null });
}

export async function redisDelKey(sessionId: string, key: string): Promise<void> {
  return invoke("redis_del_key", { sessionId, key });
}

export async function redisExec(sessionId: string, rawCommand: string): Promise<string> {
  return invoke<string>("redis_exec", { sessionId, rawCommand });
}
