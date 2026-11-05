import { isStoredInstance, record } from "./apiContracts";

export interface Instance {
  id: string;
  endpoint: string;
  label: string;
  token: string;
  deviceId: string;
  lastOnline?: number;
}
export interface Session {
  id: string;
  kind: "terminal" | "agent";
  title: string;
  status: string;
  summary: string;
  last_activity_at?: number;
}
export interface SavedSession { id: string; name: string; session_type: string; group_path: string | null }
export interface SessionList { sessions: Session[]; saved_sessions: SavedSession[]; capabilities?: { open_sessions?: boolean } }
export interface Confirmation { id: string; tool: string; supported: boolean }
export interface Detail extends Session { holder?: string; confirmations?: Confirmation[]; context_notice?: string; tools?: { id: string; name: string; status: string }[] }
export interface Changes { changes: { path: string; change_kind: string; diff_available: boolean }[]; truncated?: boolean }
export interface FileContent { path: string; content?: string; hunks?: string[]; truncated: boolean }
export class ApiError extends Error {
  constructor(public code: string) { super(code); }
}
export function endpoint(value: string): string {
  let url: URL;
  try { url = new URL(value); } catch { throw new ApiError("invalid_endpoint"); }
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || url.search || url.hash || !["", "/"].includes(url.pathname)) throw new ApiError("invalid_endpoint");
  if (location.protocol === "https:" && url.protocol === "http:") throw new ApiError("mixed_content");
  return url.origin;
}
export async function request<T>(instance: Pick<Instance, "endpoint" | "token">, path: string, body?: unknown, signal?: AbortSignal): Promise<T> {
  const abort = new AbortController();
  const cancel = () => abort.abort();
  signal?.addEventListener("abort", cancel, { once: true });
  if (signal?.aborted) abort.abort();
  const timer = setTimeout(cancel, 15000);
  try {
    const response = await fetch(`${instance.endpoint}/api/v1${path}`, {
      // A same-origin gateway may require its existing login cookie. Cookies
      // never authorize Taomni itself and must not follow cross-instance calls.
      method: body === undefined ? "GET" : "POST",
      credentials: new URL(instance.endpoint).origin === location.origin ? "same-origin" : "omit",
      cache: "no-store", redirect: "manual",
      headers: { ...(instance.token ? { Authorization: `Bearer ${instance.token}` } : {}), ...(body === undefined ? {} : { "Content-Type": "application/json" }) },
      body: body === undefined ? undefined : JSON.stringify(body), signal: abort.signal,
    });
    if (response.type === "opaqueredirect" || (response.status >= 300 && response.status < 400)) throw new ApiError("gateway_auth_required");
    if (response.status === 413) throw new ApiError("message_too_large");
    const value: unknown = await response.json().catch(() => { throw new ApiError("invalid_api_response"); });
    if (!record(value)) throw new ApiError("invalid_api_response");
    if (!response.ok) throw new ApiError(typeof value.error === "string" ? value.error : "request_failed");
    return value as T;
  } catch (error) {
    if (error instanceof ApiError) throw error;
    if (signal?.aborted) throw new DOMException("Aborted", "AbortError");
    throw new ApiError("connection_failed");
  } finally { clearTimeout(timer); signal?.removeEventListener("abort", cancel); }
}
export function errorText(error: unknown): string {
  const code = error instanceof ApiError ? error.code : "request_failed";
  return ({
    invalid_endpoint: "请输入完整的 HTTP 或 HTTPS 实例地址（不含路径）。",
    mixed_content: "HTTPS 页面无法连接 HTTP 实例，请为该实例配置 HTTPS。",
    unauthorized: "配对已吊销或失效，请重新配对。",
    origin_denied: "当前页面来源尚未配对，请生成新配对码。",
    invalid_or_expired_code: "配对码错误、已使用或已过期。",
    rate_limited: "尝试过于频繁，请稍后重试。",
    connection_failed: "连接失败，请检查实例、网络和跨域授权后重试。",
    gateway_auth_required: "网关登录已失效，请先在此浏览器打开实例主页完成登录，再重试。",
    invalid_api_response: "未收到有效的 Taomni API 响应，请先在此浏览器完成网关登录，并确认实例地址后重试。",
    diff_unavailable: "无可读的本地任务目录或 Git diff。请在桌面建立任务上下文。",
    path_denied: "该路径超出任务目录，访问已拒绝。",
    binary_file: "二进制文件无法以文本显示。",
    message_too_large: "指令不能超过 32768 UTF-8 字节，请缩短后重试。",
    turn_in_progress: "当前轮次仍在运行，请先停止或等待完成。",
    already_resolved: "该确认已在其他设备作答。",
    desktop_required: "此任务依赖桌面运行时，请在桌面继续。",
    not_supported_on_mobile: "此操作需要在桌面确认。",
    not_holder: "当前为只读，需先接管输入。",
    control_busy: "另一台设备正在控制该终端。",
    terminal_exited: "终端已退出。",
    terminal_not_found: "终端已关闭或不存在。",
    open_sessions_disabled: "实例未允许手机打开会话：请在桌面 设置 → 移动服务 中开启“允许已配对手机打开已保存会话和新建本地终端”。",
    desktop_unavailable: "实例的桌面窗口当前不可用，无法打开会话。",
    saved_session_not_found: "已保存会话不存在或已被删除，请刷新。",
    saved_session_not_terminal: "该会话类型不是终端，不能在手机上打开。",
    too_many_open_requests: "已有多个会话正在打开，请等待完成后再试。",
    open_timeout: "连接未在 3 分钟内完成，请重试或查看实例上的连接状态。",
    open_cancelled: "已取消连接。",
    invalid_auth_response: "认证信息格式无效，请重新填写。",
    open_failed: "桌面打开会话失败，请在桌面查看原因。",
    open_request_not_found: "打开请求已过期，请重试。",
    invalid_open_request: "打开请求无效。",
    desktop_size_unavailable: "已释放输入；桌面未记录终端尺寸，未能恢复桌面尺寸。",
  } as Record<string, string>)[code] || `操作失败（${code}），请重试。`;
}
const STORAGE = "taomni.mobile.instances.v1";
export function loadInstances(): Instance[] {
  try {
    const data: unknown = JSON.parse(localStorage.getItem(STORAGE) || "[]");
    return Array.isArray(data) ? data.filter(isStoredInstance) : [];
  } catch { return []; }
}
export function saveInstances(instances: Instance[]) { localStorage.setItem(STORAGE, JSON.stringify(instances)); }
export const encoded = encodeURIComponent;
export const statusText = (status: string) => ({ running: "运行中", idle: "空闲", exited: "已退出", awaiting_confirmation: "待确认" } as Record<string, string>)[status] || status;
