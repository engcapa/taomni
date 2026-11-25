/**
 * Browser-preview Git clone backend.
 *
 * It mirrors the desktop command/event contract closely enough to exercise the
 * dialog, task ownership, cancellation and workspace publication. It never
 * touches a real repository or network, and it records only redacted request
 * facts so QA artifacts cannot contain a token.
 */
import { emit } from "../tauri-event";
import { vfsMkdir, vfsStat, vfsWriteText } from "../localVfs";
import type {
  GitCloneDefaults,
  GitCloneProgress,
  GitCloneRequest,
  GitCloneResult,
} from "../../lib/gitClone";

const CONFIG_KEY = "taomni.qa.gitClone";
const REQUEST_KEY = "taomni.qa.gitClone.lastRequest";

interface StubConfig {
  defaults?: Partial<GitCloneDefaults>;
  probe?: { defaultBranch?: string; branches?: string[]; error?: string };
  scenario?: "success" | "slow" | "fail";
  seedFiles?: Record<string, string>;
  destinationRoot?: string;
}

const DEFAULT_DEFAULTS: GitCloneDefaults = {
  gitAvailable: true,
  gitVersion: "git version 2.45.0 (browser preview)",
  userName: "Preview User",
  userEmail: "preview@example.invalid",
  defaultBranch: "main",
  cloneRoot: "/preview/workspaces",
  appProxyEnabled: true,
  appProxyUrl: "http://127.0.0.1:7890",
  appProxyError: null,
  vaultState: "unlocked",
  savedTokenAvailable: false,
};

const cancelled = new Set<string>();

function readConfig(): StubConfig {
  try {
    const raw = window.localStorage.getItem(CONFIG_KEY);
    return raw ? JSON.parse(raw) as StubConfig : {};
  } catch {
    return {};
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => window.setTimeout(resolve, ms));
}

function progress(
  request: GitCloneRequest,
  phase: GitCloneProgress["phase"],
  percent: number | null,
  message: string,
  objectsDone: number | null = null,
  objectsTotal: number | null = null,
): GitCloneProgress {
  return {
    taskId: request.taskId,
    phase,
    percent,
    indeterminate: percent === null,
    message,
    objectsDone,
    objectsTotal,
  };
}

async function ensureDirectory(path: string): Promise<void> {
  const parts = path.split("/").filter(Boolean);
  let current = "";
  for (const part of parts) {
    current += `/${part}`;
    try {
      await vfsStat(current);
    } catch {
      await vfsMkdir(current);
    }
  }
}

async function seedDestination(request: GitCloneRequest, config: StubConfig): Promise<void> {
  const destination = request.destination;
  await ensureDirectory(destination);
  const files: Record<string, string> = {
    "README.md": `# ${request.workspaceName}\n\nCloned by the browser preview Git stub.\n`,
    "src/index.ts": "export const cloned = true;\n",
    ...(config.seedFiles ?? {}),
  };
  if (request.branch === "develop") files["branch-only.txt"] = "develop-only\n";
  for (const [relative, text] of Object.entries(files)) {
    await ensureDirectory(`${destination}/${relative.split("/").slice(0, -1).join("/")}`.replace(/\/$/, ""));
    await vfsWriteText(`${destination}/${relative}`, text);
  }
}

async function runClone(request: GitCloneRequest): Promise<GitCloneResult> {
  const config = readConfig();
  const slow = config.scenario === "slow";
  const delay = slow ? 350 : 90;
  const steps: Array<[GitCloneProgress["phase"], number | null, string, number | null, number | null]> = [
    ["preparing", null, `Preparing ${request.destination}`, null, null],
    ["connecting", null, `Cloning into '${request.workspaceName}'...`, null, null],
    ["counting", 2, "remote: Counting objects: 100% (12/12), done.", 12, 12],
    ["receiving", 30, "Receiving objects: 25% (3/12), 1.00 MiB", 3, 12],
    ["receiving", 52, "Receiving objects: 65% (8/12), 2.40 MiB", 8, 12],
    ["resolving", 93, "Resolving deltas: 100% (4/4), done.", 4, 4],
    ["updating", 99, "Updating files: 100% (5/5), done.", 5, 5],
    ["finalizing", 99, "Writing repository configuration", null, null],
  ];
  window.localStorage.setItem(REQUEST_KEY, JSON.stringify({
    taskId: request.taskId,
    url: request.url,
    destination: request.destination,
    workspaceName: request.workspaceName,
    branch: request.branch,
    userName: request.userName,
    userEmail: request.userEmail,
    proxyMode: request.proxyMode,
    httpProxy: request.httpProxy,
    httpsProxy: request.httpsProxy,
    tokenProvided: Boolean(request.token || request.useSavedToken),
    rememberToken: request.rememberToken,
    useSavedToken: request.useSavedToken,
  }));
  for (const [phase, percent, message, done, total] of steps) {
    if (cancelled.has(request.taskId)) {
      await emit("git-clone-progress", progress(request, "cancelled", null, "Git clone cancelled"));
      throw new Error("Git clone cancelled");
    }
    await emit("git-clone-progress", progress(request, phase, percent, message, done, total));
    await sleep(delay);
  }
  if (config.scenario === "fail") {
    const message = "fatal: unable to access remote: the requested URL returned error: 403";
    await emit("git-clone-progress", progress(request, "failed", null, message));
    throw new Error(message);
  }
  await seedDestination(request, config);
  await emit("git-clone-progress", progress(request, "completed", 100, `Cloned into ${request.destination}`));
  return {
    taskId: request.taskId,
    destination: request.destination,
    repoRoot: request.destination,
    branch: request.branch || "main",
    defaultBranch: "main",
    headOid: "0123456789abcdef0123456789abcdef01234567",
    remoteUrl: request.url,
    durationMs: delay * steps.length,
    tokenRemembered: Boolean(request.rememberToken && request.token),
  };
}

export async function invokeGitClone(cmd: string, args?: any): Promise<unknown> {
  switch (cmd) {
    case "git_clone_defaults": {
      const config = readConfig();
      return { ...DEFAULT_DEFAULTS, ...(config.defaults ?? {}) };
    }
    case "git_clone_probe": {
      const config = readConfig();
      if (config.probe?.error) throw new Error(config.probe.error);
      return {
        defaultBranch: config.probe?.defaultBranch ?? "main",
        headOid: "0123456789abcdef0123456789abcdef01234567",
        branches: config.probe?.branches ?? ["main", "develop"],
      };
    }
    case "git_clone_repository":
      return await runClone(args?.request as GitCloneRequest);
    case "git_clone_cancel": {
      const taskId = String(args?.taskId ?? "");
      if (taskId) cancelled.add(taskId);
      return undefined;
    }
    default:
      throw new Error(`Unknown Git clone stub command: ${cmd}`);
  }
}

/** Test hook for component tests that exercise a cancelled clone twice. */
export function resetGitCloneStubForTests(): void {
  cancelled.clear();
}
