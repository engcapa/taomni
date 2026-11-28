import { inflateZipEntry, parseZipCentralDirectory } from "../lib/sessionImportExport/archive";
import type { ArchiveEntry } from "../lib/openFile/archive";
import { archiveFolderName, compressionSuffix, tarSuffix } from "../lib/openFile/archiveFormats";
import { getLocale } from "../lib/i18n";
import { basenameOf, vfsMkdir, vfsReadBytes, vfsRemove, vfsRename, vfsStat, vfsWriteBytes } from "./localVfs";
import { compressedDirectory, tarDirectory } from "./tarPreview";

async function zipDirectory(bytes: Uint8Array) {
  const records = parseZipCentralDirectory(bytes);
  if (records.length > 4096) throw new Error("ZIP directory exceeds 4,096 entries");
  let total = 0;
  const entries: ArchiveEntry[] = records.map((record, index) => {
    const name = record.name.replace(/\/$/, "");
    const kind = (record.unixMode ?? 0) & 0o170000;
    if (![0, 0o100000, 0o040000].includes(kind) || name.length > 1024 || name.split("/").some((part) =>
      !part || part.length > 255 || /[. ]$|[\\:<>"|?*\x00-\x1f]|^(con|prn|aux|nul|conin\$|conout\$|(?:com|lpt)[1-9¹²³])(?:\.|$)/i.test(part))) {
      throw new Error("Archive contains an unsafe path or non-regular entry");
    }
    if (record.encrypted) throw new Error("Password-protected archives are unsupported");
    total += record.uncompressedSize;
    if (record.uncompressedSize > 32 * 1024 * 1024 || total > 256 * 1024 * 1024) throw new Error("Archive exceeds the expanded size limit");
    return { index, name, directory: record.isDirectory, size: record.uncompressedSize, crc: record.crc! };
  });
  async function content(entry: ArchiveEntry) {
    const data = await inflateZipEntry(bytes, records[entry.index], entry.size);
    if (data.length !== entry.size) throw new Error("ZIP entry size differs");
    return Uint8Array.from(data).buffer;
  }
  return { entries, content };
}

export async function loadArchive(path: string) {
  const stat = await vfsStat(path);
  if (stat.size > 64 * 1024 * 1024) throw new Error("Archive input exceeds 64 MiB");
  const name = basenameOf(path);
  const desktop = name.match(/\.(7z|rar)$/i)?.[1].toLowerCase();
  if (desktop) {
    const format = desktop === "rar" ? "RAR" : "7z";
    throw new Error(getLocale() === "zh-CN" ? `请在桌面应用中打开此 ${format} 压缩包。` : `Open this ${format} archive in the desktop app.`);
  }
  const bytes = await vfsReadBytes(path);
  const suffix = tarSuffix(name);
  const compressed = suffix ? undefined : compressionSuffix(name);
  const directory = suffix ? await tarDirectory(bytes, suffix)
    : compressed ? await compressedDirectory(bytes, compressed, archiveFolderName(name))
    : await zipDirectory(new Uint8Array(bytes));
  return { ...directory, compressed, bytes };
}

export async function invokeArchive(command: string, path: string, args: Record<string, unknown>,
  createTemp: (name: string, data: ArrayBuffer) => Promise<unknown>) {
  const { entries, content, compressed } = await loadArchive(path);
  if (command === "viewer_archive_list") return entries;
  const selected = args.entry as ArchiveEntry | undefined;
  const entry = selected ? entries[selected.index] : compressed ? entries[0] : undefined;
  if (selected && (!entry || entry.directory || entry.name !== selected.name || entry.size !== selected.size || entry.crc !== selected.crc)) {
    throw new Error("Archive changed. Reload before opening the entry");
  }
  if (command === "viewer_archive_preview" && entry) return createTemp(basenameOf(entry.name), await content(entry));
  if (command !== "viewer_archive_extract") throw new Error("Expected an archive extraction");
  const destination = String(args.destination);
  const stage = await createArchiveStage(destination);
  try {
    for (const item of entry ? [entry] : entries) await stageArchiveEntry(stage, item, content);
    return await publishArchiveStage(path, destination, stage, entry);
  } finally {
    await vfsRemove(stage.path, true);
  }
}

export async function createArchiveStage(destination: string) {
  const path = destination + "/.taomni-extract-" + crypto.randomUUID();
  await vfsMkdir(path);
  return { path, directories: new Set([path]), outputs: new Set<string>() };
}

type ArchiveStage = Awaited<ReturnType<typeof createArchiveStage>>;

export async function stageArchiveEntry(stage: ArchiveStage, item: ArchiveEntry, content: (item: ArchiveEntry) => Promise<ArrayBuffer>) {
  const output = stage.path + "/" + item.name;
  const directories = (item.directory ? item.name : item.name.split("/").slice(0, -1).join("/")).split("/").filter(Boolean);
  let parent = stage.path;
  for (const name of directories) {
    parent += "/" + name;
    if (!stage.directories.has(parent)) {
      await vfsMkdir(parent);
      stage.directories.add(parent);
    }
  }
  if (!item.directory) {
    if (stage.outputs.has(output) || stage.directories.has(output)) throw new Error("Duplicate archive entry");
    await vfsWriteBytes(output, await content(item));
    stage.outputs.add(output);
  }
}

export async function publishArchiveStage(path: string, destination: string, stage: ArchiveStage, entry?: ArchiveEntry) {
  const target = destination + "/" + (entry ? basenameOf(entry.name) : archiveFolderName(basenameOf(path)));
  await vfsRename(entry ? stage.path + "/" + entry.name : stage.path, target);
  return target;
}
