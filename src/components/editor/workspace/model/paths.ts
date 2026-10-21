import type { CodeWorkspaceFileRef, CodeWorkspaceRootInfo } from "../../../../types";
import type { WorkspaceGitRoot } from "../../../../lib/editor/workspace";
import { hashString } from "./identity";
import { type ParsedFsPath } from "./types";

export function pathName(path: string, fallback = "Workspace"): string {
  const normalized = path.replace(/[\\/]+$/, "");
  const parts = normalized.split(/[\\/]+/);
  return parts[parts.length - 1] || normalized || fallback;
}

export function rootIdForPath(path: string): string {
  return `root-${hashString(path)}`;
}

export function looseIdForPath(path: string): string {
  return `loose-${hashString(path)}`;
}

export function basename(path: string): string {
  const parts = path.split("/");
  return parts[parts.length - 1] || path;
}

export function parentPath(path: string): string {
  const idx = path.lastIndexOf("/");
  return idx === -1 ? "" : path.slice(0, idx);
}

export function joinRelativePath(parent: string, name: string): string {
  const cleanName = name.trim().replace(/^[/\\]+/, "").replace(/\\/g, "/");
  return parent ? `${parent}/${cleanName}` : cleanName;
}

export function remapRelativePath(path: string, fromPath: string, toPath: string): string {
  if (path === fromPath) return toPath;
  return path.startsWith(`${fromPath}/`) ? `${toPath}${path.slice(fromPath.length)}` : path;
}

/**
 * Return true for paths that use an unambiguous Windows filesystem prefix.
 * A plain backslash is deliberately not enough: LSP providers occasionally
 * emit backslashes for POSIX paths, and those paths must retain POSIX case
 * sensitivity when the workspace root itself is POSIX-shaped.
 */
export function windowsPathSyntax(path: string): boolean {
  if (/^[A-Za-z]:[\\/]/.test(path)) return true;
  if (path.startsWith("//")) return true;
  if (path.startsWith("\\\\")) return true;
  return path.includes("\\") && !path.startsWith("/");
}

export function isDocumentUri(path: string): boolean {
  // Drive-letter paths (`C:/...`) are filesystem paths, not URI schemes.
  if (/^[A-Za-z]:[\\/]/.test(path)) return false;
  return /^[A-Za-z][A-Za-z0-9+.-]*:\/{2,}/.test(path)
    || /^(?:file|jar|jdt|untitled|zip):/i.test(path);
}

export function stripWindowsVerbatimPrefix(path: string): { value: string; windows: boolean; } {
  const slash = path.replace(/\\/g, "/");
  const lower = slash.toLowerCase();
  if (lower.startsWith("//?/unc/")) {
    return { value: `//${slash.slice(8)}`, windows: true };
  }
  if (lower.startsWith("//?/")) {
    return { value: slash.slice(4), windows: true };
  }
  if (lower.startsWith("//./")) {
    return { value: slash.slice(4), windows: true };
  }
  return { value: slash, windows: windowsPathSyntax(path) };
}

export function parseFsPath(path: string): ParsedFsPath {
  const stripped = stripWindowsVerbatimPrefix(path);
  let value = stripped.value;

  // UNC paths need to keep the server/share pair in the prefix. Treating it
  // as ordinary segments would allow `..` to walk above the share root.
  if (value.startsWith("//")) {
    const parts = value.slice(2).split("/").filter(Boolean);
    if (parts.length >= 2) {
      return {
        prefix: `//${parts[0]}/${parts[1]}`,
        segments: parts.slice(2),
        absolute: true,
      };
    }
    return { prefix: "//", segments: parts, absolute: true };
  }

  const drive = value.match(/^([A-Za-z]):(\/)?/);
  if (drive) {
    const absolute = drive[2] === "/";
    value = value.slice(drive[0].length);
    return {
      prefix: absolute ? `${drive[1]}:/` : `${drive[1]}:`,
      segments: value.split("/").filter(Boolean),
      absolute,
    };
  }

  const absolute = value.startsWith("/");
  if (absolute) value = value.slice(1);
  return {
    prefix: absolute ? "/" : "",
    segments: value.split("/").filter(Boolean),
    absolute,
  };
}

export function normalizeSegments(segments: readonly string[], absolute: boolean): string[] {
  const normalized: string[] = [];
  for (const segment of segments) {
    if (!segment || segment === ".") continue;
    if (segment === "..") {
      const previous = normalized[normalized.length - 1];
      if (previous && previous !== "..") {
        normalized.pop();
      } else if (!absolute) {
        normalized.push("..");
      }
      continue;
    }
    normalized.push(segment);
  }
  return normalized;
}

export function renderFsPath(parsed: ParsedFsPath): string {
  const segments = normalizeSegments(parsed.segments, parsed.absolute);
  const body = segments.join("/");
  if (parsed.prefix === "/") return body ? `/${body}` : "/";
  if (parsed.prefix === "//") return body ? `//${body}` : "//";
  if (parsed.prefix.startsWith("//")) return body ? `${parsed.prefix}/${body}` : parsed.prefix;
  if (parsed.prefix.endsWith("/")) return body ? `${parsed.prefix}${body}` : parsed.prefix;
  return parsed.prefix ? `${parsed.prefix}${body}` : body;
}

/**
 * Convert a file:// URI to a local filesystem path without altering case.
 * Non-file URIs or already-filesystem paths are returned unchanged.
 */
export function fileUriToFsPath(candidate: string): string {
  if (!candidate || !/^file:\/\//i.test(candidate.trim())) return candidate;
  const trimmed = candidate.trim();
  try {
    const url = new URL(trimmed);
    if (url.protocol !== "file:") return candidate;
    let path = decodeURIComponent(url.pathname);
    if (url.hostname && url.hostname !== "localhost") {
      path = `//${url.hostname}${path}`;
    }
    if (/^\/[A-Za-z]:\//.test(path)) {
      path = path.slice(1);
    }
    return path;
  } catch {
    const stripped = trimmed.replace(/^file:\/\/(?:localhost)?\/?/i, "/");
    let path = decodeURIComponent(stripped);
    if (/^\/[A-Za-z]:\//.test(path)) {
      path = path.slice(1);
    }
    return path;
  }
}

/**
 * Normalize a filesystem path lexically across POSIX and Windows syntax.
 * `.` and `..` are folded without touching the filesystem, separators are
 * canonicalized to `/`, and Windows drive/UNC roots are preserved. URI-like
 * virtual documents are returned unchanged because they are not local paths.
 */
export function normalizeFsPath(path: string): string {
  if (!path) return path;
  if (isDocumentUri(path)) return path;
  const candidate = fileUriToFsPath(path);
  if (isDocumentUri(candidate)) return candidate;
  return renderFsPath(parseFsPath(candidate));
}

export function fsPathComparisonKey(path: string): string {
  const fsPath = fileUriToFsPath(path);
  const normalized = normalizeFsPath(fsPath);
  return windowsPathSyntax(fsPath) || windowsPathSyntax(normalized)
    ? normalized.toLocaleLowerCase("en-US")
    : normalized;
}

export function fsPathEquals(left: string, right: string): boolean {
  const leftFs = fileUriToFsPath(left);
  const rightFs = fileUriToFsPath(right);
  const windows = windowsPathSyntax(leftFs) || windowsPathSyntax(rightFs);
  const leftKey = normalizeFsPath(leftFs);
  const rightKey = normalizeFsPath(rightFs);
  return windows
    ? leftKey.toLocaleLowerCase("en-US") === rightKey.toLocaleLowerCase("en-US")
    : leftKey === rightKey;
}

export function isAbsoluteFsPath(path: string): boolean {
  if (!path || isDocumentUri(path)) return false;
  return parseFsPath(path).absolute;
}

export function relativePathWithinRoot(rootPath: string, filePath: string): string | null {
  if (!isAbsoluteFsPath(rootPath) || !isAbsoluteFsPath(filePath)) return null;
  const root = normalizeFsPath(rootPath);
  const file = normalizeFsPath(filePath);
  if (fsPathEquals(file, root)) return "";
  const windows = windowsPathSyntax(rootPath) || windowsPathSyntax(filePath);
  const comparableRoot = windows ? root.toLocaleLowerCase("en-US") : root;
  const comparableFile = windows ? file.toLocaleLowerCase("en-US") : file;
  const boundary = comparableRoot === "/" || /:\/$/.test(comparableRoot)
    ? comparableRoot
    : `${comparableRoot}/`;
  if (!comparableFile.startsWith(boundary)) return null;
  return file.slice(boundary.length);
}

export function absoluteWorkspacePath(root: CodeWorkspaceRootInfo, workspacePath: string): string {
  const rootPath = normalizeFsPath(root.path);
  const cleanPath = normalizeFsPath(workspacePath).replace(/^\/+/, "");
  return cleanPath ? `${rootPath}/${cleanPath}` : rootPath;
}

export function gitPathForWorkspacePath(
  root: CodeWorkspaceRootInfo,
  repo: WorkspaceGitRoot,
  workspacePath: string,
): string | null {
  const repoRoot = normalizeFsPath(repo.repoRoot);
  const filePath = absoluteWorkspacePath(root, workspacePath);
  if (filePath === repoRoot) return "";
  return filePath.startsWith(`${repoRoot}/`) ? filePath.slice(repoRoot.length + 1) : null;
}

export function workspacePathForGitPath(
  root: CodeWorkspaceRootInfo,
  repo: WorkspaceGitRoot,
  gitPath: string,
): string | null {
  const rootPath = normalizeFsPath(root.path);
  const repoRoot = normalizeFsPath(repo.repoRoot);
  const cleanPath = normalizeFsPath(gitPath).replace(/^\/+/, "");
  const filePath = cleanPath ? `${repoRoot}/${cleanPath}` : repoRoot;
  if (filePath === rootPath) return "";
  return filePath.startsWith(`${rootPath}/`) ? filePath.slice(rootPath.length + 1) : null;
}

export function gitRootsForWorkspaceRoot(root: CodeWorkspaceRootInfo, gitRoots: WorkspaceGitRoot[]): WorkspaceGitRoot[] {
  return gitRoots
    .filter((repo) => repo.rootIds.includes(root.id))
    .sort((a, b) => normalizeFsPath(b.repoRoot).length - normalizeFsPath(a.repoRoot).length);
}

export function gitRootForWorkspacePath(
  root: CodeWorkspaceRootInfo,
  workspacePath: string,
  gitRoots: WorkspaceGitRoot[],
): WorkspaceGitRoot | null {
  for (const repo of gitRootsForWorkspaceRoot(root, gitRoots)) {
    if (gitPathForWorkspacePath(root, repo, workspacePath) !== null) return repo;
  }
  return null;
}

export function rootDirKey(rootId: string, path = ""): string {
  return `${rootId}:${path}`;
}

export function fileKey(ref: CodeWorkspaceFileRef): string {
  return ref.kind === "root" ? `root:${ref.rootId}:${ref.path}` : `loose:${ref.id}`;
}

export function fileRefEquals(a: CodeWorkspaceFileRef, b: CodeWorkspaceFileRef): boolean {
  if (a.kind !== b.kind) return false;
  return a.kind === "root"
    ? b.kind === "root" && a.rootId === b.rootId && a.path === b.path
    : b.kind === "loose" && a.id === b.id && a.path === b.path;
}

export function fileRefUnder(ref: CodeWorkspaceFileRef, rootId: string, path: string): boolean {
  return ref.kind === "root" && ref.rootId === rootId && (ref.path === path || ref.path.startsWith(`${path}/`));
}

export function remapFileRef(ref: CodeWorkspaceFileRef, rootId: string, fromPath: string, toPath: string): CodeWorkspaceFileRef {
  if (ref.kind !== "root" || ref.rootId !== rootId) return ref;
  return { ...ref, path: remapRelativePath(ref.path, fromPath, toPath) };
}
