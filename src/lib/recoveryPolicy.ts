import type { TabKind } from "../types";

/** Exhaustive, fail-closed explanations. These policies do NOT remount clients. */
export const RECOVERY_LIMITATIONS: Record<TabKind, string> = {
  terminal: "原终端可按已知 ID 只读订阅后续输出；此前画面、光标、历史和输入模式未恢复。",
  sftp: "传输可能仍在后台运行；连接、进度和目标文件结果需核对，不自动重传或关闭原连接。",
  rdp: "远程桌面画面与输入状态未恢复；不自动重连、注销或重放按键。",
  vnc: "远程桌面画面与输入状态未恢复；不自动重连或重放剪贴板、鼠标与按键。",
  nettools: "隧道后台未被停止；控制面状态需核对，不重新启动、停止或更改规则。",
  sockscap: "SocksCap 后台未被停止；不重新启动、执行 boot repair 或切换规则。",
  welcome: "不使用欢迎页的会话重开流程替代原终端恢复，避免重复创建任务。",
  settings: "已保存设置仍可在正常启动时读取；未提交设置可能丢失，不以空白默认值覆盖。",
  placeholder: "此页面的临时状态未恢复，不触发占位工具或外部操作。",
  "file-browser": "已保存文件保留；未保存编辑、目录选择和传输进度可能丢失，不重做删除、移动或覆盖。",
  database: "查询、事务和写入结果未知；不重发 SQL、COMMIT、ROLLBACK，也不为重挂载断开旧连接。",
  redis: "连接和命令结果未知；不重复执行 Redis 命令或恢复订阅副作用。",
  "hbase-shell": "HBase 是 HTTP REST 客户端，不是 PTY；不重发 put、delete 或查询。",
  "proxy-test": "检测结果可能丢失；不自动重复测速或外部网络请求。",
  "object-storage": "上传和下载可能仍在后台运行；进度与目标文件结果需核对，不重启或取消任务。",
  "lan-chat": "已落盘的消息和文件保留；通话、采集和传输控制状态需核对，不重复发送或重录。",
  git: "工作区已保存文件保留；不重做 commit、push、pull、安装或任务命令。",
  mail: "发件箱自动发送已暂停；请核对发送结果与已保存草稿，避免重复发送。",
  "mail-unified": "发件箱自动发送已暂停；请逐账户核对发送结果与已保存草稿，避免重复发送。",
  "code-workspace": "已保存文件保留；未保存编辑、调试中间态和 AI 结果可能丢失，不重跑 build、turn 或自动批准权限。",
  mfa: "已保存 MFA 条目保留；当前筛选、临时编辑和输入未恢复，不导入或覆盖已有条目。",
};

export function recoveryLimitation(kind: string): string {
  return Object.hasOwn(RECOVERY_LIMITATIONS, kind)
    ? RECOVERY_LIMITATIONS[kind as TabKind]
    : "此页面类型未识别；后台结果未知，不自动创建连接或重复操作。";
}
