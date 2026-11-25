/** Renderer mirror of the native data-only boundary; never grants permissions. */
export function pluginDataErrors(slug: unknown, schema: unknown, paths: unknown): string[] {
  const errors: string[] = [];
  if (schema !== undefined && (typeof schema !== "number" || !Number.isInteger(schema) || schema < 1 || schema > 0xffffffff)) {
    errors.push("dataSchemaVersion must be a positive u32");
  }
  if (!Array.isArray(paths) || !paths.every((path) => typeof path === "string")) return errors;
  const root = `plugins/${slug}/data`;
  const seen = new Set<string>();
  for (const path of paths as string[]) {
    const parts = path.split("/");
    const invalid = path.length > 1024 || parts.length > 32 || /[\\:<>"|?*\x00-\x1f\x7f-\x9f]/u.test(path) ||
      parts.some((part) => !part || part === "." || part === ".." || /[. ]$/.test(part) ||
        /^(?:CON|PRN|AUX|NUL|COM[0-9]|LPT[0-9])(?:\.|$)/i.test(part));
    if (invalid || (path !== root && !path.startsWith(`${root}/`))) {
      errors.push("backupPaths must stay below plugins/<slug>/data with portable relative paths");
    }
    const canonical = path.toLowerCase();
    if (seen.has(canonical)) errors.push("backupPaths contain duplicate or case-conflicting paths");
    seen.add(canonical);
  }
  return errors;
}
