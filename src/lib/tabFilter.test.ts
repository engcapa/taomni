import { describe, expect, it } from "vitest";
import {
  deriveTabGroupPath,
  filterVisibleTabs,
  tabGroupKey,
  tabHost,
  tabMatchesFilter,
} from "./tabFilter";
import type { Tab } from "../types";
import type { SessionConfig } from "./ipc";

const session = (id: string, group_path: string | null): SessionConfig => ({
  id,
  name: id,
  session_type: "SSH",
  group_path,
  host: "10.0.0.1",
  port: 22,
  username: "root",
  auth_method: "Password",
  options_json: "{}",
  created_at: 0,
  updated_at: 0,
  last_connected_at: null,
  sort_order: 0,
});

const tab = (id: string, extra: Partial<Tab> = {}): Tab => ({
  id,
  type: "terminal",
  title: id,
  closable: true,
  ...extra,
});

const sessions = [
  session("s-cap", "User sessions / proj / cap"),
  session("s-root", null),
];

describe("deriveTabGroupPath", () => {
  it("normalizes the saved session's group_path", () => {
    expect(deriveTabGroupPath(tab("t", { sessionId: "s-cap" }), sessions)).toBe("proj / cap");
  });

  it("returns null for tabs without a session, a missing session, or a root session", () => {
    expect(deriveTabGroupPath(tab("t"), sessions)).toBeNull();
    expect(deriveTabGroupPath(tab("t", { sessionId: "gone" }), sessions)).toBeNull();
    expect(deriveTabGroupPath(tab("t", { sessionId: "s-root" }), sessions)).toBeNull();
  });

  it("buckets ungrouped tabs under the empty key", () => {
    expect(tabGroupKey(tab("t"), sessions)).toBe("");
    expect(tabGroupKey(tab("t", { sessionId: "s-cap" }), sessions)).toBe("proj / cap");
  });
});

describe("tabHost", () => {
  it("reads the host across tab kinds", () => {
    expect(tabHost(tab("t", { ssh: { sessionId: "x", host: "ssh-host", port: 22 } as Tab["ssh"] }))).toBe(
      "ssh-host",
    );
    expect(tabHost(tab("t"))).toBeNull();
  });
});

describe("tabMatchesFilter / filterVisibleTabs", () => {
  const tabs = [
    tab("cap", { sessionId: "s-cap", title: "cap-mitm" }),
    tab("local", { title: "PowerShell" }),
  ];

  it("treats a null or empty-query filter as match-all", () => {
    expect(filterVisibleTabs(tabs, sessions, null)).toHaveLength(2);
    expect(filterVisibleTabs(tabs, sessions, { kind: "query", text: "   " })).toHaveLength(2);
  });

  it("matches a query against title (case-insensitive)", () => {
    const visible = filterVisibleTabs(tabs, sessions, { kind: "query", text: "POWER" });
    expect(visible.map((t) => t.id)).toEqual(["local"]);
  });

  it("matches a group filter by directory, including the ungrouped bucket", () => {
    expect(
      filterVisibleTabs(tabs, sessions, { kind: "group", path: "proj / cap" }).map((t) => t.id),
    ).toEqual(["cap"]);
    expect(
      filterVisibleTabs(tabs, sessions, { kind: "group", path: "" }).map((t) => t.id),
    ).toEqual(["local"]);
    expect(tabMatchesFilter(tabs[0], sessions, { kind: "group", path: "" })).toBe(false);
  });
});
