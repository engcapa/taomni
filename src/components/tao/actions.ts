import type { ActionProposal, TaoBlock } from "./ai-chat/ports";

const ACTION_KINDS = new Set<ActionProposal["kind"]>(["run_command", "run_sql", "write_file", "write_note", "open_tab"]);
const DANGEROUS_COMMANDS = /(?:\brm\b|\bdel\b|\bformat(?:\.com)?\b|\bshutdown\b|\breboot\b|\bkill(?:all)?\b|\btruncate\b|\bdrop\b|\bdelete\b|\bremove-item\b)/i;

export interface ActionValidationResult {
  ok: boolean;
  action: ActionProposal;
  reason?: string;
}

export function actionLevel(action: Pick<ActionProposal, "kind" | "payload" | "expects">): ActionProposal["level"] {
  if (action.kind === "run_command" || action.kind === "run_sql") {
    const command = action.payload.command ?? action.payload.sql ?? "";
    return DANGEROUS_COMMANDS.test(command) ? "L2" : "L1";
  }
  if (action.kind === "write_file" || action.kind === "write_note") return "L1";
  return "L1";
}

export function validateActionProposal(action: ActionProposal, context: Record<string, string | undefined>): ActionValidationResult {
  if (!ACTION_KINDS.has(action.kind)) return { ok: false, action: { ...action, status: "invalid" }, reason: "动作类型不在白名单内" };
  if (!action.id || !action.title) return { ok: false, action: { ...action, status: "invalid" }, reason: "动作缺少标识或标题" };
  const level = actionLevel(action);
  const hasPayload = action.kind === "run_command"
    ? Boolean(action.payload.command?.trim())
    : action.kind === "run_sql"
      ? Boolean(action.payload.sql?.trim())
      : action.kind === "write_file"
        ? Boolean(action.payload.path?.trim() && action.payload.content !== undefined)
        : action.kind === "write_note"
          ? action.payload.content !== undefined
          : Boolean(action.payload.tabType?.trim());
  if (!hasPayload) return { ok: false, action: { ...action, level, status: "invalid" }, reason: "动作缺少必要参数" };
  const target = action.target;
  if (target?.terminalId && (!context.terminal || target.terminalId !== context.terminal)) {
    return { ok: false, action: { ...action, level, status: "invalid" }, reason: "动作越界：目标终端不是当前绑定终端" };
  }
  if (target?.databaseId && (!context.database || target.databaseId !== context.database)) {
    return { ok: false, action: { ...action, level, status: "invalid" }, reason: "动作越界：目标数据库不是当前绑定数据库" };
  }
  const path = action.payload.path ?? target?.cwd;
  const root = context.workspace;
  if (path && (!root || !isWithinPath(path, root))) {
    return { ok: false, action: { ...action, level, status: "invalid" }, reason: "动作越界：路径不在当前绑定工作区内" };
  }
  if ((action.kind === "write_file" || action.kind === "write_note") && !path) {
    return { ok: false, action: { ...action, level, status: "invalid" }, reason: "动作缺少工作区路径" };
  }
  return { ok: true, action: { ...action, level, status: "pending" } };
}

function isWithinPath(candidate: string, root: string): boolean {
  const normalize = (value: string) => {
    const normalized = value.replaceAll("\\", "/");
    const prefix = normalized.startsWith("/") ? "/" : "";
    const drive = /^[a-z]:/i.test(normalized) ? normalized.slice(0, 2).toLowerCase() : "";
    const parts = normalized.split("/").filter(Boolean);
    const stack: string[] = [];
    for (const part of parts) {
      if (part === ".") continue;
      if (part === "..") { stack.pop(); continue; }
      stack.push(part);
    }
    return `${drive}${prefix}${stack.join("/")}`.replace(/\/+$/, "").toLowerCase() || "/";
  };
  const normalizedCandidate = normalize(candidate);
  const normalizedRoot = normalize(root);
  return normalizedCandidate === normalizedRoot || normalizedCandidate.startsWith(`${normalizedRoot}/`);
}

export function parseActionProposals(text: string): ActionProposal[] {
  const actions: ActionProposal[] = [];
  const re = /```tao-action\s*([\s\S]*?)```/gi;
  for (const match of text.matchAll(re)) {
    try {
      const raw = JSON.parse(match[1]) as Partial<ActionProposal>;
      if (typeof raw.id !== "string" || typeof raw.kind !== "string" || typeof raw.title !== "string") continue;
      if (!ACTION_KINDS.has(raw.kind as ActionProposal["kind"])) continue;
      actions.push({
        id: raw.id,
        kind: raw.kind as ActionProposal["kind"],
        level: raw.level === "L1" || raw.level === "L2" ? raw.level : "L1",
        title: raw.title,
        target: raw.target,
        payload: raw.payload ?? {},
        reason: raw.reason,
        expects: raw.expects,
        status: "pending",
      });
    } catch {
      // A malformed fenced block remains visible as ordinary assistant text.
    }
  }
  return actions;
}

export function actionBlocks(actions: ActionProposal[]): TaoBlock[] {
  return actions.slice(0, 5).map((action) => ({ id: `action-${action.id}`, type: "action", action }));
}
