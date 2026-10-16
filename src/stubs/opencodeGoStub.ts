import type { GoCatalog, GoModelEntry } from "../stores/opencodeGoStore";

function entry(id: string, protocol: GoModelEntry["protocol"], patch: Partial<GoModelEntry> = {}): GoModelEntry {
  return {
    id, name: id, protocol, protocol_source: "seed", context_limit: 1000000,
    output_limit: 8192, cost: null, input_modalities: ["text"], tool_call: true,
    metadata_tool_call: true, metadata_reasoning: false, metadata_source: "catalog", output_modalities: ["text"],
    reasoning: false, interleaved_field: null, status: null, training_use: false, base_url: null,
    ...patch,
  };
}
// Renderer fixture only; not evidence of subscription or gateway availability.
export const GO_STUB_CATALOG: GoCatalog = {
  fetched_at: 0, source: "snapshot", last_error: null,
  models: [
    entry("deepseek-v4.1-flash", "chat"),
    entry("kimi-k3", "chat"),
    entry("kimi-k2.6", "chat", { status: "deprecated", metadata_tool_call: null, metadata_reasoning: null }),
    entry("minimax-m3", "messages"),
    entry("grok-4.7", "responses"),
    entry("gemini-4-argon-contributor", "google", { training_use: true }),
    entry("muse-spark-1.3-contributor", "responses", { training_use: true }),
    entry("omen-alpha", "chat", { protocol_source: "default", context_limit: null, metadata_tool_call: null, metadata_reasoning: null, metadata_source: "unlisted" }),
  ],
};

let refreshes = 0;
export function goStubCatalog(force: boolean): GoCatalog {
  const scenario = new URLSearchParams(window.location.search).get("goFixture");
  if (force) refreshes += 1;
  const base = { ...GO_STUB_CATALOG, fetched_at: Math.floor(Date.now() / 1000) };
  if (scenario === "empty") return { ...base, models: [] };
  if ((scenario === "offline" && force) || (scenario === "recovery" && force && refreshes === 1)) {
    return { ...base, source: "cache", last_error: "Fixture: offline; last-good catalog retained" };
  }
  if (scenario === "changed" && force) {
    return { ...base, source: "live", models: [
      ...base.models.filter((m) => m.id !== "kimi-k3"),
      entry("new-online-model", "chat", { protocol_source: "models_dev" }),
    ] };
  }
  return { ...base, source: force ? "live" : "snapshot" };
}
