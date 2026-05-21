export type ShellQuoteStyle = "unix" | "powershell" | "cmd";
export const NATIVE_FILE_DROP_EVENT = "newmob:native-file-drop";

export interface NativeFileDropDetail {
  paths: string[];
  clientX: number;
  clientY: number;
}

export interface DataTransferLike {
  types?: Iterable<string> | ArrayLike<string>;
  files?: Iterable<File> | ArrayLike<File>;
  getData?: (format: string) => string;
}

type FileWithPath = File & {
  path?: unknown;
};

export function isOsFileDrag(dataTransfer: DataTransferLike | null | undefined): boolean {
  const types = listFrom<string>(dataTransfer?.types);
  return types.some((type) => type === "Files" || type === "text/uri-list");
}

export function preventDefaultForOsFileDrag(event: {
  dataTransfer?: DataTransferLike | null;
  preventDefault: () => void;
}): void {
  if (isOsFileDrag(event.dataTransfer)) {
    event.preventDefault();
  }
}

export function droppedFiles(dataTransfer: DataTransferLike | null | undefined): File[] {
  return listFrom<File>(dataTransfer?.files);
}

export function droppedFilePaths(dataTransfer: DataTransferLike | null | undefined): string[] {
  const uriPaths = parseUriList(safeGetData(dataTransfer, "text/uri-list"));
  if (uriPaths.length > 0) return uniqueNonEmpty(uriPaths);

  const filePaths = droppedFiles(dataTransfer)
    .map((file) => {
      const path = (file as FileWithPath).path;
      return typeof path === "string" ? path : "";
    });
  return uniqueNonEmpty(filePaths);
}

export function parseUriList(value: string): string[] {
  return value
    .split(/\r\n|\n|\r/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"))
    .map(fileUriToPathOrUri);
}

export function shellQuoteStyleForTerminalDrop(opts: {
  isSsh: boolean;
  localShellId?: string | null;
}): ShellQuoteStyle {
  if (opts.isSsh) return "unix";

  switch (opts.localShellId) {
    case "powershell":
    case "windows-powershell":
      return "powershell";
    case "command-prompt":
      return "cmd";
    case "git-bash":
      return "unix";
    default:
      return hostLooksWindows() ? "powershell" : "unix";
  }
}

export function formatDroppedPathsForShell(paths: string[], style: ShellQuoteStyle): string {
  const quoted = paths.map((path) => quotePathForShell(path, style)).filter(Boolean);
  return quoted.length > 0 ? `${quoted.join(" ")} ` : "";
}

export function dispatchNativeFileDrop(detail: NativeFileDropDetail): void {
  window.dispatchEvent(new CustomEvent<NativeFileDropDetail>(NATIVE_FILE_DROP_EVENT, { detail }));
}

export function quotePathForShell(path: string, style: ShellQuoteStyle): string {
  const clean = path.replace(/[\x00-\x1F\x7F]/g, "");
  if (style === "powershell") {
    return `'${clean.replace(/['\u2018\u2019\u201A\u201B]/g, (match) => match + match)}'`;
  }
  if (style === "cmd") {
    if (!clean) return '""';
    return `"${clean
      .replace(/\^/g, "^^")
      .replace(/!/g, "^!")
      .replace(/"/g, '""')
      .replace(/%/g, "%%")}"`;
  }
  return `'${clean.replace(/'/g, "'\\''")}'`;
}

function listFrom<T>(value: Iterable<T> | ArrayLike<T> | null | undefined): T[] {
  if (!value) return [];
  return Array.from(value as ArrayLike<T>);
}

function safeGetData(dataTransfer: DataTransferLike | null | undefined, format: string): string {
  try {
    return dataTransfer?.getData?.(format) ?? "";
  } catch {
    return "";
  }
}

function fileUriToPathOrUri(value: string): string {
  try {
    const url = new URL(value);
    if (url.protocol !== "file:") return value;

    let path = decodeURIComponent(url.pathname);
    if (url.hostname && url.hostname !== "localhost") {
      path = `//${url.hostname}${path}`;
    }
    if (/^\/[A-Za-z]:\//.test(path)) {
      path = path.slice(1);
    }
    return path;
  } catch {
    return value;
  }
}

function uniqueNonEmpty(values: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const value of values) {
    if (!value || seen.has(value)) continue;
    seen.add(value);
    out.push(value);
  }
  return out;
}

function hostLooksWindows(): boolean {
  const nav = globalThis.navigator;
  return !!nav && /win/i.test(`${nav.platform} ${nav.userAgent}`);
}
