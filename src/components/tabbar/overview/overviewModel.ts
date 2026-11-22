import { fuzzyScore } from "../../../lib/fuzzyMatch";

export type OverviewSurface = "sessions" | "workspaces" | "explorer";

export interface PreviewItem {
  id: string;
  title: string;
  kind: string;
  group: string;
  workspaceId?: string;
  /** Owning platform surface; omitted on legacy session items means Sessions. */
  surface?: OverviewSurface;
  endpoint: string;
  summary: string;
  active: boolean;
  outputActive: boolean;
  followLatest?: boolean;
}

/** Each query word may match a different field; activity never reorders cards. */
export function filterOverviewItems(items: readonly PreviewItem[], query: string): PreviewItem[] {
  const words = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return [...items];
  return items.flatMap((item, index) => {
    const fields = [item.title, item.endpoint, item.kind, item.group, item.summary];
    let score = 0;
    for (const word of words) {
      const best = Math.max(...fields.map((field) => fuzzyScore(word, field)));
      if (!best) return [];
      score += best;
    }
    return [{ item, index, score }];
  }).sort((a, b) => b.score - a.score || a.index - b.index).map(({ item }) => item);
}
