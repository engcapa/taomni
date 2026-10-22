/** Pure tab title policy shared by the store and mounted consumers. */
function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function computeSequencedTitle(sourceTitle: string, openTitles: string[], forceSuffix: boolean): string {
  const suffixMatch = /^(.*?)-(\d+)$/.exec(sourceTitle);
  const base = suffixMatch ? suffixMatch[1] : sourceTitle;
  const familyRe = new RegExp(`^${escapeRegExp(base)}-(\\d+)$`);
  let maxSuffix = 0;
  let familyExists = false;
  for (const title of openTitles) {
    if (title === base) {
      familyExists = true;
      continue;
    }
    const match = familyRe.exec(title);
    if (match) {
      familyExists = true;
      maxSuffix = Math.max(maxSuffix, Number.parseInt(match[1], 10));
    }
  }
  if (!forceSuffix && !familyExists) return sourceTitle;
  return `${base}-${maxSuffix + 1}`;
}

export function computeDuplicateTitle(sourceTitle: string, openTitles: string[]): string {
  return computeSequencedTitle(sourceTitle, openTitles, true);
}

export function computeNewTerminalTitle(requestedTitle: string, openTerminalTitles: string[]): string {
  return computeSequencedTitle(requestedTitle, openTerminalTitles, false);
}

export function updateDuplicateAutoTitle(currentTitle: string, newPrefix: string): string {
  const suffixMatch = /^(.*?)-(\d+)$/.exec(currentTitle);
  return suffixMatch ? `${newPrefix}-${suffixMatch[2]}` : newPrefix;
}
