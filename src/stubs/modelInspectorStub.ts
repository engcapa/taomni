import type { LlmProviderConfig } from "../stores/aiStore";
import type { InspectorRow, ModelCheckResult, ProviderModels } from "../stores/modelInspectorStore";
import { goStubCatalog } from "./opencodeGoStub";

const resultKey = "taomni.stub.modelChecks.v1";
const defaults: Record<string, string> = {
  deepseek: "deepseek-chat", anthropic: "claude-sonnet-4-20250514", local: "local",
};
let refreshes = 0;
function results(): Record<string, Record<string, ModelCheckResult>> {
  try { return JSON.parse(localStorage.getItem(resultKey) ?? "{}"); } catch { return {}; }
}
function row(id: string, source: InspectorRow["metadata_source"], protocol = "chat"): InspectorRow {
  const known = source === "catalog" || source === "alias";
  return {
    id, name: id, protocol, protocol_source: null, context_limit: known ? 128000 : null,
    output_limit: known ? 8192 : null, input_modalities: known ? ["text", "image"] : null,
    output_modalities: known ? ["text"] : null, tool_call: known ? true : null,
    reasoning: known ? false : null, cost: known ? { input: 0, output: 1, cache_read: 0.1 } : null,
    status: null, metadata_source: source, live_exists: null, current: false, check: null,
  };
}
// Synthetic renderer samples, NOT metadata or gateway evidence.
export function inspectorStub(id: string, force: boolean, draft?: LlmProviderConfig): ProviderModels {
  const scenario = new URLSearchParams(window.location.search).get("inspectorFixture");
  let config;
  try { config = JSON.parse(localStorage.getItem("taomni.ai.config.v1") ?? "null"); } catch {}
  const provider = draft ?? config?.llm?.providers?.[id];
  const current = provider?.model ?? defaults[id] ?? `${id}-current`;
  const local = id === "local" || ["llama-server", "ollama"].includes(provider?.runtime);
  const blocked = !!config?.fully_disabled || (!!config?.full_local_mode && !local);
  if (force) refreshes++;
  const rows: InspectorRow[] = id === "opencode-go" ? goStubCatalog(force).models.map((m) => ({
    ...row(m.id, m.metadata_source ?? "unlisted", m.protocol),
    ...m, metadata_source: m.metadata_source ?? "unlisted",
    protocol: provider?.protocol_overrides?.[m.id] ?? m.protocol,
    protocol_source: provider?.protocol_overrides?.[m.id] ? "user_override" : m.protocol_source,
    output_modalities: m.output_modalities ?? null, tool_call: m.metadata_tool_call ?? null,
    reasoning: m.metadata_reasoning ?? null,
  })) : local ? [row("loaded-model", "live")] : [
    row(current, current === "deepseek-chat" ? "alias" : "unlisted", id === "anthropic" ? "messages" : "chat"),
    { ...row("catalog-model", "catalog", id === "anthropic" ? "messages" : "chat"), status: "deprecated", live_exists: false },
    row("unlisted-model", "unlisted"),
  ];
  if (scenario === "large" && id === "siliconflow") {
    for (let i = 0; i < 60; i++) rows.push(row(`catalog-model-${i.toString().padStart(2, "0")}`, "catalog"));
  }
  if (id === "opencode-go" && !rows.some((r) => r.id === current)) rows.push(row(current, "unlisted"));
  const uniqueRows = rows.filter((r, index) => rows.findIndex((other) => other.id === r.id) === index);
  const checks = results()[id] ?? {};
  rows.forEach((r) => { r.current = r.id === current; r.check = checks[r.id] ?? null; });
  rows.sort((a, b) => Number(b.current) - Number(a.current) || a.id.localeCompare(b.id));
  const unavailable = local && scenario === "unavailable";
  return {
    rows: unavailable || scenario === "empty" ? [] : uniqueRows, fetched_at: 1760000000,
    source: force ? "live" : "snapshot", unavailable, checks_disabled: blocked,
    last_error: scenario === "offline" || (scenario === "recovery" && force && refreshes === 1)
      ? "Fixture: offline; last-good catalog retained" : unavailable ? "Fixture: connection refused" : null,
  };
}
export function inspectorCheckStub(id: string, model: string): ModelCheckResult {
  const data = inspectorStub(id, false);
  if (data.checks_disabled) throw new Error("Model checks are disabled by the AI network policy");
  const result = {
    ok: model !== "unlisted-model", latency_ms: 12,
    error: model === "unlisted-model" ? "Fixture 401 Unauthorized\nFull gateway error" : null,
    checked_at: Math.floor(Date.now() / 1000),
  };
  const all = results();
  all[id] = { ...all[id], [model]: result };
  localStorage.setItem(resultKey, JSON.stringify(all));
  return result;
}
