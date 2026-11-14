import type { TaoSearchResult } from "../ai-chat/ports";

export interface SearchQuery {
  text: string;
  source?: string;
  host?: string;
  sinceDays?: number;
  fallbackLike: boolean;
}

export function parseSearchQuery(raw: string, now = Date.now()): SearchQuery {
  let text = raw.trim();
  let source: string | undefined;
  let host: string | undefined;
  let sinceDays: number | undefined;
  text = text.replace(/(?:^|\s)source:([^\s]+)/i, (_, value: string) => { source = value; return " "; });
  text = text.replace(/(?:^|\s)host:([^\s]+)/i, (_, value: string) => { host = value; return " "; });
  text = text.replace(/(?:^|\s)since:(\d+)d/i, (_, value: string) => { sinceDays = Number(value); return " "; });
  void now;
  const clean = text.replace(/\s+/g, " ").trim();
  return { text: clean, source, host, sinceDays, fallbackLike: Array.from(clean).length < 3 };
}

export function searchResults(results: TaoSearchResult[], rawQuery: string, now = Date.now()): { results: TaoSearchResult[]; fallbackLike: boolean } {
  const query = parseSearchQuery(rawQuery, now);
  const terms = query.text.toLocaleLowerCase();
  const since = query.sinceDays ? now - query.sinceDays * 86_400_000 : undefined;
  const filtered = results.filter((result) => {
    if (query.source && result.source !== query.source) return false;
    if (query.host && result.host !== query.host) return false;
    if (since && result.ts && result.ts < since) return false;
    if (!terms) return true;
    const haystack = `${result.title} ${result.body}`.toLocaleLowerCase();
    return query.fallbackLike ? haystack.includes(terms) : haystack.includes(terms);
  });
  const ranked = filtered.map((result) => {
    const haystack = `${result.title} ${result.body}`.toLocaleLowerCase();
    const exact = terms ? (haystack.match(new RegExp(escapeRegExp(terms), "g"))?.length ?? 0) : 0;
    const recency = result.ts ? Math.max(0, 1 - (now - result.ts) / (90 * 86_400_000)) : 0;
    return { result, score: exact * 10 + (result.useCount ?? 0) * 0.1 + recency };
  }).sort((a, b) => b.score - a.score).map(({ result }) => result);
  return { results: ranked.slice(0, 5), fallbackLike: query.fallbackLike };
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
