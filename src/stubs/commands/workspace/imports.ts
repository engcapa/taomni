import { vfsList, vfsMkdir, vfsReadBytes, vfsRemove, vfsRename, vfsStat, vfsWriteBytes } from "../../localVfs";
import type { WorkspaceImportResult } from "../../../lib/editor/workspace/importing";
import { workspaceEntryFromVfs, workspaceResourceVfsEntry } from "./resources";
import { assertWorkspaceWritablePath } from "./paths";

function relativeDirectory(value: string): string {
  if (/^(?:[/\\]|[a-z]:)/i.test(value) || value.split(/[\\/]/).includes("..")) {
    throw new Error("Workspace paths must be relative and cannot contain '..'");
  }
  return value.replace(/\\/g, "/").replace(/\/+$/, "");
}

async function copyNode(source: string, target: string): Promise<void> {
  const entry = await vfsStat(source);
  if (entry.fileType === "dir") {
    await vfsMkdir(target);
    for (const child of await vfsList(source)) {
      if (child.name.toLowerCase() === ".git") throw new Error("Writing inside .git is not allowed");
      await copyNode(child.path, `${target}/${child.name}`);
    }
  } else {
    await vfsWriteBytes(target, await vfsReadBytes(source));
  }
}

/** Browser preview copies VFS bytes only; it cannot access the host filesystem. */
export async function importStubWorkspacePaths(repoRoot: string, directory: string, sourcePaths: string[]): Promise<WorkspaceImportResult> {
  if (!sourcePaths.length) throw new Error("Nothing to import");
  const root = repoRoot.replace(/\/+$/, "");
  const relative = relativeDirectory(directory);
  assertWorkspaceWritablePath(relative);
  const destination = relative ? `${root}/${relative}` : root;
  if ((await vfsStat(destination)).fileType !== "dir") throw new Error("Import target is not a directory");
  const targets = new Set<string>();
  const plans = [];
  for (const source of sourcePaths) {
    if (!source.startsWith("/") || source.split("/").includes("..")) throw new Error(`Dropped path is not absolute: ${source}`);
    const entry = await vfsStat(source);
    const target = `${destination}/${entry.name}`;
    assertWorkspaceWritablePath(target);
    if (targets.has(target) || await workspaceResourceVfsEntry(target)) throw new Error(`Path already exists: ${target}`);
    targets.add(target);
    if (entry.fileType === "dir" && (destination === source || destination.startsWith(`${source}/`))) {
      throw new Error(`Cannot copy directory ${source} inside itself`);
    }
    plans.push({ source, target });
  }
  const result: WorkspaceImportResult = { imported: [], failures: [] };
  for (const { source, target } of plans) {
    // Own a private staging node so rollback never deletes an existing target.
    const staging = `${destination}/.taomni-import-${crypto.randomUUID()}`;
    try {
      await copyNode(source, staging);
      await vfsRename(staging, target);
      result.imported.push(await workspaceEntryFromVfs(root, target));
    } catch (error) {
      let message = error instanceof Error ? error.message : String(error);
      try { await vfsRemove(staging, true); } catch (cleanup) { message += `; partial copy cleanup failed: ${String(cleanup)}`; }
      result.failures.push({ sourcePath: source, message });
    }
  }
  return result;
}
