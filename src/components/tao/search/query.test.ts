import { describe, expect, it } from "vitest";
import { parseSearchQuery, searchResults } from "./query";

describe("Tao Search query", () => {
  it("parses source, host and date filters", () => {
    expect(parseSearchQuery("source:sql host:u80 since:14d orders")).toMatchObject({ source: "sql", host: "u80", sinceDays: 14, text: "orders", fallbackLike: false });
  });

  it("uses exact matching for short Chinese terms and limits results", () => {
    const results = Array.from({ length: 7 }, (_, index) => ({ id: String(index), source: "note", ref: String(index), title: index === 0 ? "发布流程" : "其他", body: index === 0 ? "发布" : "其他内容", ts: Date.now(), useCount: index }));
    const ranked = searchResults(results, "发布");
    expect(ranked.fallbackLike).toBe(true);
    expect(ranked.results[0].title).toBe("发布流程");
    expect(ranked.results.length).toBeLessThanOrEqual(5);
  });
});
