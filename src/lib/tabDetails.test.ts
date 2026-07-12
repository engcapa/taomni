import { describe, expect, it } from "vitest";
import type { Tab } from "../types";
import type { SessionConfig } from "./ipc";
import { buildTabDetailSummary } from "./tabDetails";

const t = (key: string, args?: Record<string, unknown>) =>
  `${key}${args ? `:${Object.values(args).join(",")}` : ""}`;

const saved: SessionConfig = {
  id: "prod",
  name: "Production",
  session_type: "SSH",
  group_path: null,
  host: "10.0.0.8",
  port: 22,
  username: "root",
  auth_method: "None",
  options_json: "{}",
  created_at: 0,
  updated_at: 0,
  last_connected_at: null,
  sort_order: 0,
};

describe("buildTabDetailSummary", () => {
  it("combines a saved session with live terminal activity", () => {
    const tab: Tab = {
      id: "term",
      type: "terminal",
      title: "taomni",
      sessionId: "prod",
      closable: true,
      ssh: { sessionId: "prod", host: "10.0.0.8", port: 22, username: "root", authMethod: "None", authData: null },
    };
    expect(buildTabDetailSummary(
      tab,
      [saved],
      { state: "running", program: "vite", backendSessionId: "runtime-1", updatedAt: 1 },
      "/srv/taomni",
      t,
    )).toMatchObject({
      sessionLabel: "Production",
      sessionDetail: "SSH · root@10.0.0.8:22",
      activityLabel: "tabs.detailsRunningProgram:vite",
      cwd: "/srv/taomni",
      backendSessionId: "runtime-1",
    });
  });

  it("labels unsaved local terminals without inventing a session", () => {
    const tab: Tab = { id: "local", type: "terminal", title: "home", closable: true };
    expect(buildTabDetailSummary(tab, [], { state: "idle", updatedAt: 1 }, "/home/ada", t)).toMatchObject({
      sessionLabel: "tabs.detailsTemporaryLocal",
      activityLabel: "tabs.detailsIdle:tabs.detailsShell",
    });
  });
});
