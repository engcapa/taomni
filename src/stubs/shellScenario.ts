/** Opt-in IPC fixture for renderer cases. Native builds use the Rust backend. */
import { vfsList, vfsMkdir, vfsReadText, vfsWriteText, vfsStat } from "./localVfs";
import { emit } from "./tauri-event";
import { shellTransferInvoke } from "./shellTransferFixture";
import { CWD_INTEGRATION_DONE_MARKER } from "../lib/terminalShellIntegration";
const PREFIX = "taomni.qa.shell.";
const terminals = new Map<string, { output?: { onmessage(data: number[]): void }; cwd: string; input: string; cwdIntegration: boolean }>();
const sftp = new Map<string, string>();
const sftpOwners = new Map<string, string>();
let sequence = 0;
export const SHELL_SCENARIO_COMMANDS = ["create_local_terminal", "create_ssh_terminal", "save_session", "sftp_attach", "sftp_cancel_transfer", "workspace_list_dir", "workspace_write_file", "workspace_write_file_encoded", "workspace_write_loose_file_encoded", "db_save_query_workspace", "open_detached_window", "get_welcome_run_snapshot", "notes_list", "notes_get", "notes_update", "notes_list_alerts", "notes_ack_alert", "chat_list_threads", "chat_list_messages", "mail_list_cached_folders", "mail_list_cached_messages", "chat_stream", "test_proxy_connection"] as const;
export function shellScenarioEnabled() { return localStorage.getItem(`${PREFIX}enabled`) === "true"; }
function observe(command: string, owner: string, status: string) {
  const values = JSON.parse(localStorage.getItem(`${PREFIX}observations`) ?? "[]") as unknown[];
  localStorage.setItem(`${PREFIX}observations`, JSON.stringify([...values.slice(-999), { command, owner, status }]));
}
export async function shellScenarioBefore(command: string, args: Record<string, unknown> = {}) {
  if (!shellScenarioEnabled()) return;
  const owner = String(args.host ?? args.repoRoot ?? args.sessionId ?? "");
  const key = `${PREFIX}fault`, rule = JSON.parse(localStorage.getItem(key) ?? "null") as { command: string; owner?: string; mode: string; once?: boolean; claimed?: boolean } | null;
  observe(command, owner, "requested");
  if (!rule || rule.command !== command || rule.owner && !owner.includes(rule.owner)) return;
  if (rule.mode === "fail-next") { localStorage.removeItem(key); observe(command, owner, "failed"); throw new Error(`QA fixture rejected ${command}`); }
  if (rule.mode === "hold") {
    if (rule.once) {
      if (rule.claimed) return;
      localStorage.setItem(key, JSON.stringify({ ...rule, claimed: true }));
    }
    if (command === "chat_stream") return; // Hold after the first tokens below.
    observe(command, owner, "held");
    const deadline = Date.now() + 10000;
    while (localStorage.getItem(key) && Date.now() < deadline) await new Promise<void>((resolve) => setTimeout(resolve, 25));
    if (localStorage.getItem(key)) throw new Error(`QA fixture held ${command} beyond preparation deadline`);
  }
}
function output(sessionId: string, text: string) { terminals.get(sessionId)?.output?.onmessage([...new TextEncoder().encode(text)]); }
export async function shellScenarioInvoke(command: string, args: any = {}): Promise<{ value: unknown } | null> {
  if (!shellScenarioEnabled()) return null;
  if (command === "test_proxy_connection") {
    observe(command, String(args.proxyHost), "completed");
    return { value: `QA proxy accepted ${args.testHost}:${args.testPort}` };
  }
  if (command === "chat_stream") {
    const req = args.req, threadId = String(req.thread_id), now = Math.floor(Date.now() / 1000);
    const user = { id: crypto.randomUUID(), thread_id: threadId, role: "user", content: String(req.content), created_at: now, redacted: false, attachments: req.attachments ?? [] };
    const assistant = { ...user, id: crypto.randomUUID(), role: "assistant", content: `QA fixture reply: ${req.content}`, attachments: [] };
    const event = `chat-stream:${threadId}`;
    await emit(event, { kind: "user_message", message: user });
    await emit(event, { kind: "assistant_start", id: assistant.id, thread_id: threadId, created_at: now });
    await emit(event, { kind: "token", id: assistant.id, content: "QA fixture reply: " });
    const key = `${PREFIX}fault`, rule = JSON.parse(localStorage.getItem(key) ?? "null");
    if (rule?.command === command && rule.mode === "hold") {
      observe(command, threadId, "held");
      const deadline = Date.now() + 10000;
      while (localStorage.getItem(key) && Date.now() < deadline) await new Promise<void>((resolve) => setTimeout(resolve, 25));
      if (localStorage.getItem(key)) throw new Error("Chat fixture hold exceeded the preparation deadline");
    }
    const storageKey = "taomni.stub.chatMessages.v1", messages = JSON.parse(localStorage.getItem(storageKey) ?? "{}");
    messages[threadId] = [...(messages[threadId] ?? []), user, assistant];
    localStorage.setItem(storageKey, JSON.stringify(messages));
    await emit(event, { kind: "end", id: assistant.id, thread_id: threadId, content: assistant.content, redacted_count: 0 });
    observe(command, threadId, "completed");
    return { value: undefined };
  }
  if (command === "create_local_terminal" || command === "create_ssh_terminal") {
    if (command === "create_ssh_terminal" && !String(args.host).endsWith(".invalid")) return null;
    const id = args.sessionId || `shell-fixture-${++sequence}`;
    terminals.set(id, { output: args.onOutput, cwd: args.cwd ?? "/preview", input: "", cwdIntegration: false });
    setTimeout(() => output(id, `QA-${args.host ?? "LOCAL"}\r\n$ `), 0);
    return { value: command === "create_local_terminal" ? { sessionId: id, shellId: args.shell ?? "/bin/sh", taskEnvironment: {} } : id };
  }
  const terminal = terminals.get(args.sessionId);
  if (terminal && command === "attach_terminal_output") { terminal.output = args.onOutput; return { value: undefined }; }
  if (terminal && command === "write_terminal") {
    const text = new TextDecoder().decode(Uint8Array.from(atob(args.data), (c) => c.charCodeAt(0)));
    output(args.sessionId, text.replace(/\r/g, "\r\n")); terminal.input += text;
    if (/[\r\n]/.test(terminal.input)) {
      const line = terminal.input.trim(); terminal.input = "";
      if (line.includes("__taomni_osc7") && line.includes("printf '\\033]633;TaomniCwdIntegrationDone\\a'")) {
        // Model the shell's external protocol, including the private marker
        // that releases the renderer's setup echo suppressor.
        const cwd = line.match(/ cd '((?:[^']|'\\'')*)' 2>\/dev\/null;/)?.[1];
        if (cwd !== undefined) terminal.cwd = cwd.replace(/'\\''/g, "'");
        terminal.cwdIntegration = true;
        output(args.sessionId, `\x1b]133;A\x1b\\\x1b]7;file://qa${encodeURI(terminal.cwd)}\x1b\\${CWD_INTEGRATION_DONE_MARKER}$ `);
        return { value: undefined };
      }
      if (line.startsWith("cd ")) terminal.cwd = line.slice(3).replace(/^['"]|['"]$/g, "");
      else if (line === "pwd") output(args.sessionId, `${terminal.cwd}\r\n`);
      else if (line.startsWith("echo ")) output(args.sessionId, `${line.slice(5)}\r\n`);
      output(args.sessionId, `${terminal.cwdIntegration ? `\x1b]133;A\x1b\\\x1b]7;file://qa${encodeURI(terminal.cwd)}\x1b\\` : ""}$ `);
    }
    return { value: undefined };
  }
  if (terminal && ["resize_terminal", "close_terminal"].includes(command)) { if (command === "close_terminal") terminals.delete(args.sessionId); return { value: undefined }; }
  if (command === "sftp_attach" && String(args.host).endsWith(".invalid")) {
    const root = args.host.includes("beta") ? "/preview/shell-remote-b" : "/preview/shell-remote-a";
    sftp.set(args.sessionId, root);
    sftpOwners.set(args.sessionId, args.host);
    await vfsMkdir(root); await vfsMkdir(`${root}/中文 目录`); await vfsWriteText(`${root}/alpha.txt`, "alpha\nbeta\ngamma\n");
    if (localStorage.getItem("taomni.qa.shell.transferControlled") === "true") await vfsWriteText(`${root}/job.txt`, "SHELL-TRANSFER-中文\n".repeat(4096));
    return { value: { homeDir: "/home/qa" } };
  }
  const root = sftp.get(args.sessionId);
  const transfer = await shellTransferInvoke(command, args, root, sftpOwners.get(args.sessionId));
  if (transfer) return transfer;
  if (!root) return null;
  const remote = (path: string) => `${root}/${String(path ?? "").replace(/^\/home\/qa\/?/, "").replace(/^\/+/, "")}`.replace(/\/$/, "");
  if (command === "sftp_realpath") return { value: args.path === "." ? "/home/qa" : args.path };
  if (command === "sftp_list_remote") return { value: (await vfsList(remote(args.path))).map((entry) => ({ ...entry, path: entry.path.replace(root, "/home/qa") })) };
  if (command === "sftp_stat") return { value: await vfsStat(remote(args.path)) };
  if (command === "sftp_read_file_text") return { value: await vfsReadText(remote(args.path)) };
  if (command === "sftp_write_file_text") { await vfsWriteText(remote(args.path), args.text); return { value: undefined }; }
  if (command === "sftp_detach") { sftp.delete(args.sessionId); sftpOwners.delete(args.sessionId); return { value: undefined }; }
  return null;
}
