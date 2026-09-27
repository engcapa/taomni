import type { GitBlobPair, GitChange, GitSnapshot } from "../lib/git";
import { vfsReadText } from "./localVfs";

/**
 * ED-PARITY-008 browser fixture: two local repositories (F3 manifest from the
 * IDEA reference) served through the real Tauri-stub `invoke` channel so the
 * production Code Workspace → Git tab → Changes → DiffPane chain runs in the
 * browser. Worktree text is read from the browser VFS; HEAD/index text and
 * object ids are fixed manifest values. Any Git mutation is recorded and
 * rejected: the fixture proves renderer routing and zero-write intent, never
 * real Git bytes (the native case owns disk evidence).
 */

export const parity008Root = "/preview/parity008";
const enabledKey = "taomni.qa.parity008.enabled";
const holdKey = "taomni.qa.parity008.holdPairRepo";

interface RepoFixture {
  name: string;
  headOid: string;
  changes: GitChange[];
  headText: Record<string, string>;
}

const REPOS: Record<string, RepoFixture> = {
  [`${parity008Root}/repo-a`]: {
    name: "repo-a",
    headOid: "8748e377acc709469beca3ee792e83e24c10be45",
    changes: [
      { path: "same.txt", oldPath: null, status: "modified", staged: true, unstaged: true, conflict: false },
      { path: "untracked.txt", oldPath: null, status: "untracked", staged: false, unstaged: true, conflict: false },
    ],
    headText: { "same.txt": "repo-a HEAD\nshared line\n" },
  },
  [`${parity008Root}/repo-b`]: {
    name: "repo-b",
    headOid: "909b2b27c0efdc9def85adf69b07ccc6cfdc95eb",
    changes: [
      { path: "same.txt", oldPath: null, status: "modified", staged: false, unstaged: true, conflict: false },
    ],
    headText: { "same.txt": "repo-b HEAD\nshared line\n" },
  },
};

export const parity008WorktreeFiles: Record<string, string> = {
  "repo-a/same.txt": "repo-a WORKTREE\nshared line\n",
  "repo-a/stable.txt": "stable\n",
  "repo-a/untracked.txt": "untracked A\n",
  "repo-b/same.txt": "repo-b WORKTREE\nshared line\n",
  "repo-b/stable.txt": "stable\n",
};

const READ_COMMANDS = new Set([
  "git_snapshot", "git_blob_pair", "git_operation_state", "git_log", "git_stash_list",
  "git_commit_files", "git_blame_lines", "git_probe_path",
]);

const events: Array<{ cmd: string; repoRoot: string; path: string | null; at: number }> = [];
const writes: Array<{ cmd: string; repoRoot: string }> = [];
const heldPairs: Array<{ repoRoot: string; release: () => void }> = [];

function enabled(): boolean {
  try { return localStorage.getItem(enabledKey) === "true"; } catch { return false; }
}

function holdRepo(): string | null {
  try { return localStorage.getItem(holdKey); } catch { return null; }
}

function normalize(path: unknown): string {
  return typeof path === "string" ? path.replace(/\\/g, "/").replace(/\/+$/, "") : "";
}

/** True when this invoke belongs to the isolated fixture. */
export function parity008Handles(cmd: string, args: Record<string, unknown> | undefined): boolean {
  if (!enabled()) return false;
  if (cmd === "workspace_detect_git_roots") {
    const roots = Array.isArray(args?.roots) ? args.roots as Array<{ path?: unknown }> : [];
    return roots.some((root) => normalize(root.path) === parity008Root);
  }
  if (!cmd.startsWith("git_")) return false;
  return normalize(args?.repoRoot) in REPOS;
}

function snapshot(repoRoot: string): GitSnapshot {
  const repo = REPOS[repoRoot]!;
  return {
    repoRoot,
    currentBranch: "main",
    headOid: repo.headOid,
    detached: false,
    upstream: null,
    ahead: 0,
    behind: 0,
    changes: repo.changes.map((change) => ({ ...change })),
    remotes: [],
    branches: [{
      name: "main", fullName: "main", current: true, remote: false, upstream: null,
      oid: repo.headOid, subject: "fixture baseline",
    }],
    stashes: [],
    tags: [],
    settings: {
      userName: "Parity Fixture", userEmail: "fixture@example.invalid", httpProxy: null, httpsProxy: null,
      pullRebase: null, pushDefault: null, coreAutocrlf: "false", coreFilemode: null, commitGpgsign: null,
    },
  };
}

async function blobPair(repoRoot: string, path: string): Promise<GitBlobPair> {
  const repo = REPOS[repoRoot]!;
  const oldText = repo.headText[path] ?? null;
  let newText: string | null = null;
  try { newText = await vfsReadText(`${repoRoot}/${path}`); } catch { newText = null; }
  const encoder = new TextEncoder();
  return {
    path,
    oldPath: null,
    oldText,
    newText,
    oldExists: oldText !== null,
    newExists: newText !== null,
    binary: false,
    image: false,
    oldImageB64: null,
    newImageB64: null,
    oversize: false,
    oldSize: oldText === null ? 0 : encoder.encode(oldText).length,
    newSize: newText === null ? 0 : encoder.encode(newText).length,
  };
}

export async function parity008Invoke(cmd: string, args: Record<string, unknown> | undefined): Promise<unknown> {
  if (cmd === "workspace_detect_git_roots") {
    const root = (args?.roots as Array<{ id: string; path: string }>).find((item) => normalize(item.path) === parity008Root)!;
    return Object.entries(REPOS).map(([repoRoot, repo]) => ({
      id: repo.name,
      name: repo.name,
      path: parity008Root,
      repoRoot,
      rootIds: [root.id],
    }));
  }
  const repoRoot = normalize(args?.repoRoot);
  const path = typeof args?.path === "string" ? args.path : null;
  events.push({ cmd, repoRoot, path, at: Date.now() });
  if (!READ_COMMANDS.has(cmd)) {
    writes.push({ cmd, repoRoot });
    throw new Error(`parity008 fixture: Git write '${cmd}' refused`);
  }
  switch (cmd) {
    case "git_snapshot":
      return snapshot(repoRoot);
    case "git_blob_pair": {
      const pair = blobPair(repoRoot, path ?? "");
      if (holdRepo() === repoRoot) {
        return new Promise((resolve) => heldPairs.push({ repoRoot, release: () => resolve(pair) }));
      }
      return pair;
    }
    case "git_operation_state":
      return { kind: "none", conflictedPaths: [] };
    default:
      return [];
  }
}

declare global {
  interface Window {
    __taomniQaParity008?: {
      observe: () => {
        writes: typeof writes;
        pending: string[];
        pairReads: Array<{ repoRoot: string; path: string | null }>;
        snapshotReads: string[];
      };
      hold: (repoRoot: string | null) => void;
      release: () => number;
    };
  }
}

if (typeof window !== "undefined") {
  window.__taomniQaParity008 = {
    observe: () => ({
      writes: [...writes],
      pending: heldPairs.map((held) => held.repoRoot),
      pairReads: events.filter((event) => event.cmd === "git_blob_pair").map(({ repoRoot, path }) => ({ repoRoot, path })),
      snapshotReads: events.filter((event) => event.cmd === "git_snapshot").map((event) => event.repoRoot),
    }),
    hold: (repoRoot) => {
      try {
        if (repoRoot) localStorage.setItem(holdKey, repoRoot);
        else localStorage.removeItem(holdKey);
      } catch { /* fixture only */ }
    },
    release: () => {
      const count = heldPairs.length;
      for (const held of heldPairs.splice(0)) held.release();
      return count;
    },
  };
}
