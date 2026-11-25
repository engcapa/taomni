import type { TunnelConfig } from "../../lib/tunnel";

export function firstTunnelError(draft: TunnelConfig) {
  if (!draft.name.trim()) return { field: "name", message: "tunnels.editor.errNameRequired" };
  if (!draft.ssh.host.trim()) return { field: "host", message: "tunnels.editor.errHostRequired" };
  if (!draft.ssh.username.trim()) return { field: "username", message: "tunnels.editor.errUsernameRequired" };
  if (!validPort(draft.ssh.port)) return { field: "port", message: "tunnels.editor.errSshPort" };
  if (!validPort(draft.listenPort)) {
    return { field: "listenPort", message: draft.kind === "Remote" ? "tunnels.editor.errRemotePortGt0" : "tunnels.editor.errForwardPortGt0" };
  }
  if (draft.kind !== "Dynamic") {
    if (!draft.destHost.trim()) return { field: "destHost", message: "tunnels.editor.errDestHostRequired" };
    if (!validPort(draft.destPort)) return { field: "destPort", message: "tunnels.editor.errRemotePortGt0" };
  }
  return null;
}

function validPort(port: number) {
  return Number.isInteger(port) && port >= 1 && port <= 65535;
}
