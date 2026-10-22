import { VFS_ROOT, vfsList, vfsMkdir, vfsReadBytes, vfsReadText, vfsRemove, vfsRename, vfsStat, vfsWriteBytes, vfsWriteText } from "../../localVfs";
import { parity005Enabled, parity005Root } from "../../parity005Completion";
import { parity007Enabled, parity007Root, parity007WriteFailure } from "../../parity007Extract";
import { parity009Cancel, parity009Capabilities, parity009Run } from "../../parity009StructuralSearch";
import { emit } from "../../tauri-event";
import { decodeStubBytes, encodeStubText, readStubWorkspaceEncodedFile, sha256Bytes, sha256Hex } from "./encoding";
import { assertWorkspaceWritablePath, joinWorkspacePath, relativeWorkspacePath } from "./paths";
import { applyStubWorkspaceResourceOperation, workspaceEntryFromVfs, type StubWorkspaceResourceOperation } from "./resources";
import { stubSearchCancelIds, stubSearchCancelled, stubWorkspaceSearch } from "./search";

export async function invokeWorkspace<T>(cmd: string, args?: any): Promise<T> {
  switch (cmd) {

    case "structural_search_capabilities":
      return parity009Capabilities() as T;

    case "structural_search_run":
      return await parity009Run(args?.request) as T;

    case "structural_search_cancel":
      return parity009Cancel((args?.requestId as string) ?? "") as T;

    case "workspace_ingest_maven_project": {
      const workspaceRoot = String((args?.request as { workspaceRoot?: string; } | undefined)?.workspaceRoot ?? "");
      if (parity005Enabled() && workspaceRoot === parity005Root) {
        return {
          status: "ready",
          modules: [{
            id: "parity005:completion", name: "completion", root: parity005Root,
            pomPath: `${parity005Root}/pom.xml`,
            sourceRoots: [`${parity005Root}/src/main/java`], testRoots: [], resourceRoots: [],
            outputDir: null, dependencies: ["org.apache.commons:commons-lang3:3.12.0"],
            classpath: ["commons-lang3-3.12.0.jar"],
          }],
          provenance: {
            toolKind: "qa-fixture", toolVersion: null, javaHome: null, javaVersion: null,
            argv: [], cwd: parity005Root, pomHash: "B-005", resolvedAt: new Date().toISOString(),
          },
          errorMessage: null,
        } as T;
      }
      if (parity007Enabled() && workspaceRoot === parity007Root) {
        return {
          status: "ready",
          modules: [{
            id: "parity007:extract", name: "extract", root: parity007Root,
            pomPath: `${parity007Root}/pom.xml`,
            sourceRoots: [`${parity007Root}/src/main/java`], testRoots: [], resourceRoots: [],
            outputDir: null, dependencies: [],
            classpath: [],
          }],
          provenance: {
            toolKind: "qa-fixture", toolVersion: null, javaHome: null, javaVersion: null,
            argv: [], cwd: parity007Root, pomHash: "B-007", resolvedAt: new Date().toISOString(),
          },
          errorMessage: null,
        } as T;
      }
      // No build backend exists in the browser preview. Return no usable
      // result instead of a well-formed failed response so the store's typed
      // prerequisite failure (ED-PROJECT-005 A4) names the missing backend
      // exactly as the desktop build does when no Maven tooling is present.
      return undefined as T;
    }

    case "workspace_list_dir": {
      const repoRoot = (args?.repoRoot as string) || VFS_ROOT;
      const path = (args?.path as string) || "";
      const target = joinWorkspacePath(repoRoot, path);
      const entries = await vfsList(target);
      return entries.map((entry) => ({
        name: entry.name,
        path: relativeWorkspacePath(repoRoot, entry.path),
        fileType: entry.fileType === "dir" ? "dir" : entry.fileType === "file" ? "file" : "other",
        size: entry.size,
        mtime: entry.mtime,
        isHidden: entry.isHidden,
      })) as T;
    }

    case "workspace_compact_chain": {
      // Mirror the native walk: descend while a directory holds exactly one
      // child directory, up to maxDepth; report the final path's entries.
      const repoRoot = (args?.repoRoot as string) || VFS_ROOT;
      const path = (args?.path as string) || "";
      const maxDepth = (args?.maxDepth as number | null) ?? 16;
      let current = joinWorkspacePath(repoRoot, path);
      let currentRel = path;
      for (let depth = 0; depth < maxDepth; depth++) {
        const entries = await vfsList(current);
        const mapped = entries.map((entry) => ({
          name: entry.name,
          path: relativeWorkspacePath(repoRoot, entry.path),
          fileType: entry.fileType === "dir" ? "dir" : entry.fileType === "file" ? "file" : "other",
          size: entry.size,
          mtime: entry.mtime,
          isHidden: entry.isHidden,
        }));
        if (mapped.length !== 1 || mapped[0].fileType !== "dir") {
          return { path: currentRel, entries: mapped } as T;
        }
        current = joinWorkspacePath(current, mapped[0].name);
        currentRel = mapped[0].path;
      }
      const finalEntries = await vfsList(current);
      return {
        path: currentRel,
        entries: finalEntries.map((entry) => ({
          name: entry.name,
          path: relativeWorkspacePath(repoRoot, entry.path),
          fileType: entry.fileType === "dir" ? "dir" : entry.fileType === "file" ? "file" : "other",
          size: entry.size,
          mtime: entry.mtime,
          isHidden: entry.isHidden,
        })),
      } as T;
    }

    case "workspace_list_files_recursive": {
      // Mirror collect_workspace_files: files only (dirs recursed, not
      // emitted), .git skipped, depth/file capped, sorted case-insensitively.
      const repoRoot = (args?.repoRoot as string) || VFS_ROOT;
      const maxDepth = (args?.maxDepth as number | null) ?? 16;
      const maxFiles = (args?.maxFiles as number | null) ?? 2000;
      const out: Array<{
        name: string;
        path: string;
        fileType: "dir" | "file" | "other";
        size: number;
        mtime: number;
        isHidden: boolean;
      }> = [];
      const walk = async (dir: string, rel: string, depth: number): Promise<void> => {
        if (depth > maxDepth || out.length >= maxFiles) return;
        const entries = await vfsList(dir);
        for (const entry of entries) {
          if (entry.name === ".git" || entry.path.startsWith(".git/")) continue;
          const childRel = rel ? `${rel}/${entry.name}` : entry.name;
          if (entry.fileType === "file") {
            out.push({
              name: entry.name,
              path: childRel,
              fileType: "file",
              size: entry.size,
              mtime: entry.mtime,
              isHidden: entry.isHidden,
            });
            if (out.length >= maxFiles) return;
          } else if (entry.fileType === "dir" && depth < maxDepth) {
            await walk(joinWorkspacePath(dir, entry.name), childRel, depth + 1);
            if (out.length >= maxFiles) return;
          }
        }
      };
      await walk(joinWorkspacePath(repoRoot, (args?.path as string) || ""), "", 0);
      out.sort((a, b) => a.path.toLowerCase().localeCompare(b.path.toLowerCase()));
      return out as T;
    }

    case "workspace_read_file": {
      const repoRoot = (args?.repoRoot as string) || VFS_ROOT;
      const path = args?.path as string;
      const target = joinWorkspacePath(repoRoot, path);
      const [entry, text] = await Promise.all([vfsStat(target), vfsReadText(target)]);
      const bom = text.startsWith("\uFEFF");
      return {
        path: relativeWorkspacePath(repoRoot, entry.path),
        text: bom ? text.slice(1) : text,
        encoding: "UTF-8",
        bom,
        size: entry.size,
        mtime: entry.mtime,
        hash: await sha256Hex(text),
      } as T;
    }

    case "workspace_detect_git_roots": {
      // The in-memory VFS has no .git directories; report no repos so
      // useWorkspaceGitSnapshots keeps an empty (never undefined) list.
      return [] as unknown as T;
    }

    case "workspace_read_loose_file": {
      const path = args?.path as string;
      const [entry, text] = await Promise.all([vfsStat(path), vfsReadText(path)]);
      const bom = text.startsWith("\uFEFF");
      return {
        path: entry.path,
        text: bom ? text.slice(1) : text,
        encoding: "UTF-8",
        bom,
        size: entry.size,
        mtime: entry.mtime,
        hash: await sha256Hex(text),
      } as T;
    }

    case "workspace_read_file_with_encoding": {
      const repoRoot = (args?.repoRoot as string) || VFS_ROOT;
      const path = args?.path as string;
      const encoding = (args?.encoding as string) || "UTF-8";
      const file = await readStubWorkspaceEncodedFile(path, repoRoot, encoding);
      return {
        path: file.filePath,
        text: file.text,
        encoding: file.encoding,
        bom: file.bom,
        size: file.entry.size,
        mtime: file.entry.mtime,
        hash: await sha256Bytes(file.bytes),
      } as T;
    }

    case "workspace_read_loose_file_with_encoding": {
      const path = args?.path as string;
      const encoding = (args?.encoding as string) || "UTF-8";
      const file = await readStubWorkspaceEncodedFile(path, null, encoding);
      return {
        path: file.filePath,
        text: file.text,
        encoding: file.encoding,
        bom: file.bom,
        size: file.entry.size,
        mtime: file.entry.mtime,
        hash: await sha256Bytes(file.bytes),
      } as T;
    }

    case "workspace_write_file": {
      const repoRoot = (args?.repoRoot as string) || VFS_ROOT;
      const path = args?.path as string;
      assertWorkspaceWritablePath(path);
      const target = joinWorkspacePath(repoRoot, path);
      const expectedHash = (args?.expectedHash as string | null | undefined)?.trim();
      if (expectedHash) {
        const current = await vfsReadText(target);
        const currentHash = await sha256Hex(current);
        if (currentHash !== expectedHash) {
          throw new Error(`hash-mismatch: File changed on disk; expected hash ${expectedHash}, found ${currentHash}`);
        }
      }
      const contents = (args?.contents as string) ?? "";
      await vfsWriteText(target, contents);
      const entry = await vfsStat(target);
      return {
        path: relativeWorkspacePath(repoRoot, entry.path),
        text: contents.startsWith("\uFEFF") ? contents.slice(1) : contents,
        encoding: "UTF-8",
        bom: contents.startsWith("\uFEFF"),
        size: entry.size,
        mtime: entry.mtime,
        hash: await sha256Hex(contents),
      } as T;
    }

    case "workspace_write_loose_file": {
      const path = args?.path as string;
      assertWorkspaceWritablePath(path);
      const expectedHash = (args?.expectedHash as string | null | undefined)?.trim();
      if (expectedHash) {
        const current = await vfsReadText(path);
        const currentHash = await sha256Hex(current);
        if (currentHash !== expectedHash) {
          throw new Error(`hash-mismatch: File changed on disk; expected hash ${expectedHash}, found ${currentHash}`);
        }
      }
      const contents = (args?.contents as string) ?? "";
      await vfsWriteText(path, contents);
      const entry = await vfsStat(path);
      return {
        path: entry.path,
        text: contents.startsWith("\uFEFF") ? contents.slice(1) : contents,
        encoding: "UTF-8",
        bom: contents.startsWith("\uFEFF"),
        size: entry.size,
        mtime: entry.mtime,
        hash: await sha256Hex(contents),
      } as T;
    }

    case "workspace_search_start": {
      // Browser-preview workspace search (ED-FIND-003): synchronous VFS grep
      // over roots inside the VFS jail. Proves panel routing, scope/mask
      // planning, preview, and cancel in browser mode; the native ripgrep
      // backend remains the production search path. Roots outside the VFS
      // are skipped (the browser cannot read host disk).
      const searchId = (args?.searchId as string) || "";
      const roots = (Array.isArray(args?.roots) ? args?.roots : []) as Array<{
        id?: unknown;
        name?: unknown;
        path?: unknown;
      }>;
      const query = (args?.query as string) ?? "";
      const options = (args?.options as Record<string, unknown> | null) ?? {};
      const cancelled = stubSearchCancelled(searchId);
      const emitSearch = (payload: Record<string, unknown>) => {
        if (cancelled()) return;
        void emit(`workspace-search-${searchId}`, payload);
      };
      void stubWorkspaceSearch(searchId, roots, query, options, cancelled, emitSearch);
      return searchId as T;
    }

    case "workspace_search_cancel": {
      stubSearchCancelIds.add((args?.searchId as string) || "");
      return true as T;
    }

    case "workspace_write_file_encoded":

    case "workspace_write_loose_file_encoded": {
      const isRoot = cmd === "workspace_write_file_encoded";
      const repoRoot = isRoot ? ((args?.repoRoot as string) || VFS_ROOT) : null;
      const path = args?.path as string;
      const target = repoRoot ? joinWorkspacePath(repoRoot, path) : path;
      assertWorkspaceWritablePath(path);
      // ED-PARITY-007 controlled write failure for the isolated fixture only.
      if (isRoot && parity007Enabled(target) && parity007WriteFailure(target)) {
        throw new Error("B-007 controlled write failure: the workspace file could not be written");
      }
      const expectedHash = (args?.expectedHash as string | null | undefined)?.trim();
      const currentBytes = new Uint8Array(await vfsReadBytes(target));
      const oldHash = await sha256Bytes(currentBytes);
      if (expectedHash) {
        if (oldHash !== expectedHash) {
          throw new Error(`hash-mismatch: File changed on disk; expected hash ${expectedHash}, found ${oldHash}`);
        }
      }
      const encoding = (args?.encoding as string) || "UTF-8";
      const bytes = encodeStubText((args?.contents as string) ?? "", encoding, !!args?.bom);
      const writtenHash = await sha256Bytes(bytes);
      const storedBytes = new Uint8Array(bytes.byteLength);
      storedBytes.set(bytes);
      await vfsWriteBytes(target, storedBytes.buffer);
      const entry = await vfsStat(target);
      const decoded = decodeStubBytes(bytes, encoding);
      return {
        file: {
          path: repoRoot ? relativeWorkspacePath(repoRoot, entry.path) : entry.path,
          text: decoded.text,
          encoding: decoded.encoding,
          bom: decoded.bom,
          size: entry.size,
          mtime: entry.mtime,
          hash: writtenHash,
        },
        writtenHash,
        writtenByteLength: bytes.byteLength,
        intentHash: writtenHash,
        oldHash,
        atomicReplaceUsed: false,
      } as T;
    }

    case "workspace_create_file": {
      const repoRoot = (args?.repoRoot as string) || VFS_ROOT;
      const path = args?.path as string;
      assertWorkspaceWritablePath(path);
      const target = joinWorkspacePath(repoRoot, path);
      await vfsStat(target)
        .then(() => {
          throw new Error(`Path already exists: ${target}`);
        })
        .catch((err) => {
          if (err instanceof Error && err.message.startsWith("Path already exists:")) throw err;
        });
      const contents = (args?.contents as string | null | undefined) ?? "";
      await vfsWriteText(target, contents);
      const entry = await vfsStat(target);
      return {
        path: relativeWorkspacePath(repoRoot, entry.path),
        text: contents.startsWith("\uFEFF") ? contents.slice(1) : contents,
        encoding: "UTF-8",
        bom: contents.startsWith("\uFEFF"),
        size: entry.size,
        mtime: entry.mtime,
        hash: await sha256Hex(contents),
      } as T;
    }

    case "workspace_create_dir": {
      const repoRoot = (args?.repoRoot as string) || VFS_ROOT;
      const path = args?.path as string;
      assertWorkspaceWritablePath(path);
      const target = joinWorkspacePath(repoRoot, path);
      await vfsStat(target)
        .then(() => {
          throw new Error(`Path already exists: ${target}`);
        })
        .catch((err) => {
          if (err instanceof Error && err.message.startsWith("Path already exists:")) throw err;
        });
      await vfsMkdir(target);
      return await workspaceEntryFromVfs(repoRoot, target) as T;
    }

    case "workspace_delete_path": {
      const repoRoot = (args?.repoRoot as string) || VFS_ROOT;
      const path = args?.path as string;
      assertWorkspaceWritablePath(path);
      const target = joinWorkspacePath(repoRoot, path);
      if (relativeWorkspacePath(repoRoot, target) === "") {
        throw new Error("Cannot delete the workspace root");
      }
      await vfsRemove(target, !!args?.recursive);
      return undefined as T;
    }

    case "workspace_rename_path": {
      const repoRoot = (args?.repoRoot as string) || VFS_ROOT;
      const fromPath = args?.fromPath as string;
      const toPath = args?.toPath as string;
      assertWorkspaceWritablePath(fromPath);
      assertWorkspaceWritablePath(toPath);
      const from = joinWorkspacePath(repoRoot, fromPath);
      const to = joinWorkspacePath(repoRoot, toPath);
      await vfsStat(to)
        .then(() => {
          throw new Error(`Path already exists: ${to}`);
        })
        .catch((err) => {
          if (err instanceof Error && err.message.startsWith("Path already exists:")) throw err;
        });
      await vfsRename(from, to);
      return await workspaceEntryFromVfs(repoRoot, to) as T;
    }

    case "workspace_apply_resource_operation": {
      return await applyStubWorkspaceResourceOperation(
        (args?.repoRoot as string) || VFS_ROOT,
        args?.operation as StubWorkspaceResourceOperation,
      ) as T;
    }

    case "workspace_detect_tasks": {
      return [] as T;
    }

    case "workspace_java_run_targets": {
      return [] as T;
    }

    case "workspace_task_tree": {
      return [] as T;
    }

    case "workspace_dependency_tree": {
      return [] as T;
    }

    case "workspace_execution_model": {
      return {
        projects: [],
        buildTargets: [],
        runConfigurations: [],
        debugConfigurations: [],
        tools: [],
        diagnostics: [],
      } as T;
    }

    case "workspace_test_results": {
      // Browser preview has no desktop filesystem or JVM process. Keep the
      // structured protocol shape so TestsPanel can render an honest empty
      // result state without pretending that tests were executed.
      return {
        schema: "taomni.codeWorkspace.testResults",
        version: 1,
        source: "junit-xml",
        generatedAt: Date.now(),
        results: [],
        summary: {
          total: 0,
          passed: 0,
          failed: 0,
          skipped: 0,
          errors: 0,
          durationMs: 0,
        },
        diagnostics: ["Structured test results are available only in the Taomni desktop app"],
      } as T;
    }
    default: throw new Error(`Unhandled workspace stub command: ${cmd}`);
  }
}
