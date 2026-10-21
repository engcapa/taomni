import { useMemo } from "react";
import { useLanChatStore } from "../../../stores/lanChatStore";
import { presenceLabel } from "../util";

/** Header info for the currently selected conversation. */
export function useActiveHeader() {
  const activeConvId = useLanChatStore((s) => s.activeConvId);
  const roster = useLanChatStore((s) => s.roster);
  const groups = useLanChatStore((s) => s.groups);
  return useMemo(() => {
    if (!activeConvId) return null;
    if (activeConvId.startsWith("direct:")) {
      const peerId = activeConvId.slice("direct:".length);
      const peer = roster.find((p) => p.id === peerId);
      return {
        kind: "direct" as const,
        name: peer?.name ?? peerId.slice(0, 8),
        colorKey: peerId,
        status: peer?.status ?? "offline",
        sub: peer ? `${presenceLabel(peer.status)}${peer.addr ? ` · ${peer.addr}` : ""}` : "离线",
        label: undefined as string | undefined,
      };
    }
    const groupId = activeConvId.slice("group:".length);
    const group = groups.find((g) => g.id === groupId);
    return {
      kind: "group" as const,
      name: group?.name ?? "群组",
      colorKey: groupId,
      status: null,
      sub: group ? `${group.members.length} 人` : "",
      label: "#",
    };
  }, [activeConvId, roster, groups]);
}
