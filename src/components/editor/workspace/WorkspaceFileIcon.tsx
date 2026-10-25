import {
  Braces, Database, File, FileArchive, FileJson2, FileSpreadsheet,
  FileTerminal, FileText, Film, Folder, FolderOpen, Image, Music2,
} from "lucide-react";

/** Shared by folder, search and loose-file views; no provider is needed. */
export function WorkspaceFileIcon({ path, folder = false, expanded = false }: {
  path: string;
  folder?: boolean;
  expanded?: boolean;
}) {
  const name = path.replace(/\\/g, "/").split("/").pop()?.toLowerCase() ?? "";
  const extension = name.includes(".") ? name.split(".").pop() ?? "" : "";
  let kind = "file";
  let Icon = File;
  if (folder) {
    kind = "folder";
    Icon = expanded ? FolderOpen : Folder;
  } else if (/^(png|jpe?g|gif|webp|svg|ico|bmp|avif|heic|tiff?)$/.test(extension)) {
    kind = "image";
    Icon = Image;
  } else if (/^(mp4|mov|avi|mkv|webm)$/.test(extension)) {
    kind = "video";
    Icon = Film;
  } else if (/^(mp3|wav|flac|ogg|m4a|aac)$/.test(extension)) {
    kind = "audio";
    Icon = Music2;
  } else if (/^(zip|tar|gz|bz2|xz|7z|rar|jar)$/.test(extension)) {
    kind = "archive";
    Icon = FileArchive;
  } else if (/^(csv|tsv|xlsx?|ods)$/.test(extension)) {
    kind = "spreadsheet";
    Icon = FileSpreadsheet;
  } else if (/^(sql|db|sqlite3?)$/.test(extension)) {
    kind = "database";
    Icon = Database;
  } else if (/^(jsonc?|ya?ml|toml|ini|xml|env|properties)$/.test(extension) || name.startsWith(".env")) {
    kind = "config";
    Icon = FileJson2;
  } else if (/^(sh|bash|zsh|fish|ps1|bat|cmd)$/.test(extension)) {
    kind = "script";
    Icon = FileTerminal;
  } else if (/^(tsx?|jsx?|java|kt|kts|rs|py|go|[ch]|[ch]pp|cs|rb|php|swift|vue|svelte|html|css|scss)$/.test(extension)) {
    kind = "code";
    Icon = Braces;
  } else if (/^(md|txt|pdf|docx?|rtf|odt|log)$/.test(extension) || /^(readme|license|changelog)$/.test(name)) {
    kind = "document";
    Icon = FileText;
  }
  return <Icon aria-hidden="true" data-file-type={kind} className="taomni-explorer-file-icon h-3.5 w-3.5 shrink-0" />;
}
