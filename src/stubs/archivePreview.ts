import { inflateZipEntry, parseZipCentralDirectory } from "../lib/sessionImportExport/archive";
import type { ArchiveEntry } from "../lib/openFile/archive";
import { archiveFolderName, tarSuffix } from "../lib/openFile/archiveFormats";
import { basenameOf, vfsMkdir, vfsReadBytes, vfsRemove, vfsRename, vfsStat, vfsWriteBytes } from "./localVfs";
import { tarDirectory } from "./tarPreview";

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

export async function invokeArchive(command: string, path: string, args: Record<string, unknown>,
  createTemp: (name: string, data: ArrayBuffer) => Promise<unknown>) {
  const stat = await vfsStat(path);
  if (stat.size > 64 * 1024 * 1024) throw new Error("Archive input exceeds 64 MiB");
  const bytes = await vfsReadBytes(path);
  const suffix = tarSuffix(basenameOf(path));
  const { entries, content } = suffix ? await tarDirectory(bytes, suffix) : await zipDirectory(new Uint8Array(bytes));
  if (command === "viewer_archive_list") return entries;
  const selected = args.entry as ArchiveEntry | undefined;
  const entry = selected && entries[selected.index];
  if (selected && (!entry || entry.directory || entry.name !== selected.name || entry.size !== selected.size || entry.crc !== selected.crc)) {
    throw new Error("Archive changed. Reload before opening the entry");
  }
  if (command === "viewer_archive_preview" && entry) return createTemp(basenameOf(entry.name), await content(entry));
  if (command !== "viewer_archive_extract") throw new Error("Expected an archive extraction");
  const dest = String(args.destination);
  const folder = dest + "/.taomni-extract-" + crypto.randomUUID();
  const target = dest + "/" + (entry ? basenameOf(entry.name) : archiveFolderName(basenameOf(path)));
  await vfsMkdir(folder);
  try {
    const created = new Set([folder]);
    const outputs = new Set<string>();
    for (const item of entry ? [entry] : entries) {
      const output = folder + "/" + item.name;
      const directories = (item.directory ? item.name : item.name.split("/").slice(0, -1).join("/")).split("/").filter(Boolean);
      let parent = folder;
      for (const name of directories) {
        parent += "/" + name;
        if (!created.has(parent)) { await vfsMkdir(parent); created.add(parent); }
      }
      if (!item.directory) {
        if (outputs.has(output) || created.has(output)) throw new Error("Duplicate archive entry");
        await vfsWriteBytes(output, await content(item));
        outputs.add(output);
      }
    }
    await vfsRename(entry ? folder + "/" + entry.name : folder, target);
    return target;
  } finally {
    // vfsRemove is a no-op once the staged directory has moved.
    await vfsRemove(folder, true);
  }
}
