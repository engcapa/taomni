/** Opt-in IPC fixture for renderer cases. Native builds use the Rust backend. */
import { vfsList, vfsMkdir, vfsReadText, vfsWriteText, vfsStat } from "./localVfs";
const PREFIX = "taomni.qa.shell.";
const terminals = new Map<string, { output?: { onmessage(data: number[]): void }; cwd: string; input: string }>();
const sftp = new Map<string, string>();
let sequence = 0;
export const SHELL_SCENARIO_COMMANDS = ["create_local_terminal", "create_ssh_terminal", "save_session", "sftp_attach", "workspace_list_dir", "workspace_write_file", "workspace_write_file_encoded", "workspace_write_loose_file_encoded", "db_save_query_workspace", "open_detached_window", "get_welcome_run_snapshot"] as const;
export function shellScenarioEnabled() { return localStorage.getItem(`${PREFIX}enabled`) === "true"; }
function observe(command: string, owner: string, status: string) {
  const values = JSON.parse(localStorage.getItem(`${PREFIX}observations`) ?? "[]") as unknown[];
  localStorage.setItem(`${PREFIX}observations`, JSON.stringify([...values.slice(-999), { command, owner, status }]));
}
export async function shellScenarioBefore(command: string, args: Record<string, unknown> = {}) {
  if (!shellScenarioEnabled()) return;
  const owner = String(args.host ?? args.repoRoot ?? args.sessionId ?? "");
  const key = `${PREFIX}fault`, rule = JSON.parse(localStorage.getItem(key) ?? "null") as { command: string; owner?: string; mode: string } | null;
  observe(command, owner, "requested");
  if (!rule || rule.command !== command || rule.owner && !owner.includes(rule.owner)) return;
  if (rule.mode === "fail-next") { localStorage.removeItem(key); observe(command, owner, "failed"); throw new Error(`QA fixture rejected ${command}`); }
  if (rule.mode === "hold") {
    observe(command, owner, "held");
    const deadline = Date.now() + 10000;
    while (localStorage.getItem(key) && Date.now() < deadline) await new Promise<void>((resolve) => setTimeout(resolve, 25));
    if (localStorage.getItem(key)) throw new Error(`QA fixture held ${command} beyond preparation deadline`);
  }
}
function output(sessionId: string, text: string) { terminals.get(sessionId)?.output?.onmessage([...new TextEncoder().encode(text)]); }
export async function shellScenarioInvoke(command: string, args: any = {}): Promise<{ value: unknown } | null> {
  if (!shellScenarioEnabled()) return null;
  if (command === "create_local_terminal" || command === "create_ssh_terminal") {
    if (command === "create_ssh_terminal" && !String(args.host).endsWith(".invalid")) return null;
    const id = args.sessionId || `shell-fixture-${++sequence}`;
    terminals.set(id, { output: args.onOutput, cwd: args.cwd ?? "/preview", input: "" });
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
      if (line.startsWith("cd ")) terminal.cwd = line.slice(3).replace(/^['"]|['"]$/g, "");
      else if (line === "pwd") output(args.sessionId, `${terminal.cwd}\r\n`);
      else if (line.startsWith("echo ")) output(args.sessionId, `${line.slice(5)}\r\n`);
      output(args.sessionId, "$ ");
    }
    return { value: undefined };
  }
  if (terminal && ["resize_terminal", "close_terminal"].includes(command)) { if (command === "close_terminal") terminals.delete(args.sessionId); return { value: undefined }; }
  if (command === "sftp_attach" && String(args.host).endsWith(".invalid")) {
    const root = args.host.includes("beta") ? "/preview/shell-remote-b" : "/preview/shell-remote-a";
    sftp.set(args.sessionId, root);
    await vfsMkdir(root); await vfsMkdir(`${root}/中文 目录`); await vfsWriteText(`${root}/alpha.txt`, "alpha\nbeta\ngamma\n");
    return { value: { homeDir: "/home/qa" } };
  }
  const root = sftp.get(args.sessionId);
  if (!root) return null;
  const remote = (path: string) => `${root}/${String(path ?? "").replace(/^\/home\/qa\/?/, "").replace(/^\/+/, "")}`.replace(/\/$/, "");
  if (command === "sftp_realpath") return { value: args.path === "." ? "/home/qa" : args.path };
  if (command === "sftp_list_remote") return { value: (await vfsList(remote(args.path))).map((entry) => ({ ...entry, path: entry.path.replace(root, "/home/qa") })) };
  if (command === "sftp_stat") return { value: await vfsStat(remote(args.path)) };
  if (command === "sftp_read_file_text") return { value: await vfsReadText(remote(args.path)) };
  if (command === "sftp_write_file_text") { await vfsWriteText(remote(args.path), args.text); return { value: undefined }; }
  if (command === "sftp_detach") { sftp.delete(args.sessionId); return { value: undefined }; }
  return null;
}
