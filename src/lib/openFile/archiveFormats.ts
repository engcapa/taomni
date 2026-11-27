const tarSuffixes = [".tar.gz", ".tar.bz2", ".tar.xz", ".tar.zst", ".tgz", ".tar"] as const;
const compressionSuffixes = [".gz", ".bz2", ".xz", ".zst"] as const;

export function tarSuffix(name: string) {
  const lower = name.toLowerCase();
  return tarSuffixes.find((suffix) => lower.endsWith(suffix));
}

export function isArchiveName(name: string): boolean {
  return Boolean(tarSuffix(name) ?? compressionSuffix(name)) || /\.(zip|cbz|7z)$/i.test(name);
}

export function compressionSuffix(name: string) {
  const lower = name.toLowerCase();
  return compressionSuffixes.find((suffix) => lower.endsWith(suffix));
}

export function archiveFolderName(name: string): string {
  const suffix = tarSuffix(name);
  return suffix ? name.slice(0, -suffix.length) : name.replace(/\.[^.]+$/, "");
}
