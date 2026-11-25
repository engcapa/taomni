import type { ServerConfig, ServerType } from "../servers";

export interface ServerSettingsInput {
  serverType: ServerType;
  config: ServerConfig;
  onChange: (patch: Partial<ServerConfig>) => void;
}

export type ServerSettingsModule = "rdp-server" | "vnc-server" | "servers";

export function serverSettingsModule(type: ServerType): ServerSettingsModule {
  if (type === "rdp") return "rdp-server";
  if (type === "vnc") return "vnc-server";
  return "servers";
}
