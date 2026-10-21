import { type InvokeArgs } from "./runtime";

/* --------------------------- LanChat preview mocks --------------------------- */
export const LANCHAT_MOCK_PEERS = [
  { id: "zhao", name: "赵敏 · 设计部", avatarHash: null, signature: "设计即沟通", status: "online", lastSeen: Date.now(), addr: "192.168.1.24", port: 47100 },
  { id: "qian", name: "钱进 · 后端", avatarHash: null, signature: "勿扰，发版中", status: "busy", lastSeen: Date.now(), addr: "192.168.1.31", port: 47100 },
  { id: "sun", name: "孙莉 · 测试", avatarHash: null, signature: "测试一切", status: "away", lastSeen: Date.now(), addr: "192.168.1.46", port: 47100 },
  { id: "li", name: "李工 · 运维", avatarHash: null, signature: "稳定第一", status: "online", lastSeen: Date.now(), addr: "192.168.1.12", port: 47100 },
  { id: "zhou", name: "周哲", avatarHash: null, signature: "", status: "offline", lastSeen: Date.now(), addr: null, port: null },
];

export const LANCHAT_MOCK_GROUPS = [
  { id: "g1", name: "研发大群", createdAt: Date.now() - 86400000, members: ["me-preview", "zhao", "qian", "sun", "li"] },
  { id: "g2", name: "前端小队", createdAt: Date.now() - 43200000, members: ["me-preview", "zhao"] },
];

export const LANCHAT_MOCK_CONVERSATIONS = [
  { id: "direct:zhao", kind: "direct", peerOrGroupId: "zhao", lastMsgAt: Date.now() - 60000, unread: 0 },
  { id: "direct:qian", kind: "direct", peerOrGroupId: "qian", lastMsgAt: Date.now() - 600000, unread: 2 },
  { id: "group:g1", kind: "group", peerOrGroupId: "g1", lastMsgAt: Date.now() - 120000, unread: 5 },
];

export const LANCHAT_MOCK_MESSAGES: Record<string, unknown[]> = {
  "direct:zhao": [
    { id: "p1", convId: "direct:zhao", senderId: "zhao", body: "早呀，新版内网通讯的配色我调好了 ✨", mentions: [], createdAt: Date.now() - 300000, state: "delivered" },
    { id: "p2", convId: "direct:zhao", senderId: "me-preview", body: "太好了！发我看看", mentions: [], createdAt: Date.now() - 240000, state: "delivered" },
    { id: "p3", convId: "direct:zhao", senderId: "me-preview", body: "收到，@赵敏 这个主色和我们 Taomni 的靛蓝很搭 👍", mentions: ["zhao"], createdAt: Date.now() - 60000, state: "delivered" },
  ],
  "group:g1": [
    { id: "g1m1", convId: "group:g1", senderId: "sun", body: "周会改到下午三点哈", mentions: [], createdAt: Date.now() - 180000, state: "delivered" },
    { id: "g1m2", convId: "group:g1", senderId: "li", body: "收到 👌", mentions: [], createdAt: Date.now() - 150000, state: "delivered" },
    { id: "g1m3", convId: "group:g1", senderId: "me-preview", body: "好的，记得带上各自的进度", mentions: [], createdAt: Date.now() - 120000, state: "sent" },
  ],
};

export async function invokeLanchat<T>(cmd: string, args?: any): Promise<T> {
  switch (cmd) {

    /* ----------------------------- LanChat (内网通讯) ----------------------------- */
    case "lanchat_status": {
      return { running: false, nodeId: "preview", peerCount: LANCHAT_MOCK_PEERS.length } as T;
    }

    case "lanchat_list_peers": {
      return LANCHAT_MOCK_PEERS as T;
    }

    case "lanchat_get_profile": {
      return {
        id: "me-preview",
        name: "林开发",
        avatarBase64: null,
        avatarHash: null,
        signature: "摸鱼中，勿扰 ✨",
        status: "online",
        updatedAt: Date.now(),
      } as T;
    }

    case "lanchat_list_conversations": {
      return LANCHAT_MOCK_CONVERSATIONS as T;
    }

    case "lanchat_list_groups": {
      return LANCHAT_MOCK_GROUPS as T;
    }

    case "lanchat_list_messages": {
      const convId = (args as InvokeArgs | undefined)?.convId as string | undefined;
      return ((convId && LANCHAT_MOCK_MESSAGES[convId]) ?? []) as T;
    }

    case "lanchat_mark_read": {
      return undefined as T;
    }

    case "lanchat_open_path": {
      return undefined as T;
    }

    case "lanchat_send_text":

    case "lanchat_send_group_text":

    case "lanchat_resend_message":

    case "lanchat_update_profile":

    case "lanchat_create_group":

    case "lanchat_leave_group":

    case "lanchat_send_file":

    case "lanchat_send_group_file":

    case "lanchat_send_dir":

    case "lanchat_accept_file":

    case "lanchat_reject_file":

    case "lanchat_transfer_control":

    case "lanchat_send_screenshot":

    case "lanchat_send_clipboard_image":

    case "lanchat_send_signal":

    case "lanchat_signal_group": {
      throw new Error("内网通讯仅桌面版可用：浏览器预览不支持真实发现与直连。");
    }
    default: throw new Error(`Unhandled lanchat stub command: ${cmd}`);
  }
}
