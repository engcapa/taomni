import type { AgentResource, AgentSettings } from "../../../lib/ipc/orchestration";
import type { AppProxyConfig } from "../../../lib/ipc/proxy";

export const defaultResourceProxy = (): AppProxyConfig => ({
  enabled: true, mode: "manual", session_id: "", kind: "http", host: "", port: 3128, username: "", password_ref: "",
});
export function newAgentResource(name: string): AgentResource {
  return {
    id: crypto.randomUUID(), name, kind: "api", protocol: "openai_chat", providerId: "",
    model: "", baseUrl: "", keyRef: "", harness: "claude_code", binary: "", args: [],
    costCoefficient: 1, proxyMode: "app", customProxy: null,
  };
}
export function hasValidAgentSettings(settings: AgentSettings): boolean {
  const ids = new Set(settings.resources.map((resource) => resource.id));
  return !!settings.name.trim()
    && Number.isInteger(settings.concurrency) && settings.concurrency > 0 && settings.concurrency <= 4
    && ids.has(settings.planningResourceId) && ids.has(settings.reviewResourceId)
    && ids.size === settings.resources.length
    && settings.workerResourceIds.every((id) => settings.resources.some((resource) => resource.id === id && resource.kind === "worker"))
    && settings.resources.every((resource) => {
      if (!resource.name.trim() || !Number.isFinite(resource.costCoefficient) || resource.costCoefficient <= 0) return false;
      if (resource.keyRef && !/^vault:\S+$/.test(resource.keyRef)) return false;
      if (resource.customProxy?.password_ref && !/^vault:\S+$/.test(resource.customProxy.password_ref)) return false;
      if (resource.kind === "api" && (!resource.model.trim() || !resource.baseUrl.trim())) return false;
      if (resource.kind === "worker" && !resource.binary.trim()) return false;
      if (resource.proxyMode === "custom") {
        const proxy = resource.customProxy;
        if (!proxy?.enabled) return false;
        if (proxy.mode === "session") return !!proxy.session_id;
        return !!proxy.host.trim() && Number.isInteger(proxy.port) && proxy.port > 0 && proxy.port <= 65535;
      }
      return true;
    });
}
