import { describe, expect, it } from "vitest";
import { closeSuccessor, defaultLane, matchesTabSearch, panelIdentity, stripTabs, tabLane, tabSearchText } from "./tabPresentation";
import type { Tab } from "../../types";

describe("Shell navigation identity", () => {
  it("bounds the strip and retains an active item past the overflow boundary", () => {
    const tabs = Array.from({ length: 30 }, (_, i) => ({ id: String(i), type: "terminal", title: String(i), closable: true } as Tab));
    expect(stripTabs(tabs, "29").map((t) => t.id)).toEqual(["0", "1", "2", "3", "4", "29"]);
    expect(stripTabs(tabs.slice(0, 6), "5")).toEqual(tabs.slice(0, 6));
    expect(stripTabs([], null)).toEqual([]);
    expect(tabs[5].id).toBe("5");
  });
  it("classifies every business kind and safely presents future kinds", () => {
    const groups = { home: ["welcome"], connect: ["terminal", "sftp", "rdp", "vnc", "file-browser", "object-storage"],
      build: ["code-workspace", "git", "database", "redis", "hbase-shell"], communicate: ["mail", "mail-unified", "lan-chat"],
      utility: ["nettools", "sockscap", "proxy-test", "mfa", "settings", "placeholder", "future-kind"] };
    for (const [lane, kinds] of Object.entries(groups)) for (const kind of kinds) expect(defaultLane(kind)).toBe(lane);
    expect(tabLane({ type: "welcome" } as Tab, "build")).toBe("home");
  });
  it("keeps two workspaces at the same path independent", () => {
    expect(panelIdentity("git", { kind: "workspace", tabId: "a", workspaceInstanceId: "w1" }))
      .not.toBe(panelIdentity("git", { kind: "workspace", tabId: "b", workspaceInstanceId: "w2" }));
  });
  it("searches normalized display fields with AND tokens without exposing secrets", () => {
    const tab = { id: "a", type: "terminal", title: "Cafe\u0301 Production", ssh: { host: "SSH.EXAMPLE", authData: "SECRET" } } as Tab;
    expect(matchesTabSearch(tab, " CAFÉ ssh.example ")).toBe(true);
    expect(matchesTabSearch(tab, "café missing")).toBe(false);
    expect(tabSearchText(tab)).not.toContain("secret");
  });
  it("closes to lane MRU and leaves an unrelated active tab alone", () => {
    const tabs: Tab[] = [{ id: "home", type: "welcome", title: "Home", closable: false },
      { id: "a", type: "terminal", title: "a", closable: true }, { id: "b", type: "git", title: "b", closable: true },
      { id: "c", type: "sftp", title: "c", closable: true }];
    expect(closeSuccessor(tabs, new Set(["a"]), "a", ["a", "b", "c", "home"], {})).toBe("c");
    expect(closeSuccessor(tabs, new Set(["b"]), "a", ["a", "b", "c"], {})).toBe("a");
  });
});
