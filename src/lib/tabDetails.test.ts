import { describe, expect, it } from "vitest";
import type { Tab } from "../types";
import type { SessionConfig } from "./ipc";
import { buildTabDetailSummary, formatTabSessionInfo } from "./tabDetails";

const t = (key: string, args?: Record<string, unknown>) =>
  `${key}${args ? `:${Object.values(args).join(",")}` : ""}`;

const saved: SessionConfig = {
  id: "prod",
  name: "Production",
  session_type: "SSH",
  group_path: "Work / prod",
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
      connectionLabel: "tabs.detailsRemote",
      endpoint: "root@10.0.0.8:22",
      activityLabel: "tabs.detailsRunningProgram:vite",
      program: "vite",
      cwd: "/srv/taomni",
    });
  });

  it("labels unsaved local terminals without inventing a session", () => {
    const tab: Tab = { id: "local", type: "terminal", title: "home", closable: true };
    expect(buildTabDetailSummary(tab, [], { state: "idle", updatedAt: 1 }, "/home/ada", t)).toMatchObject({
      sessionLabel: "tabs.detailsTemporaryLocal",
      connectionLabel: "tabs.detailsLocal",
      endpoint: null,
      activityLabel: "tabs.detailsIdle:tabs.detailsShell",
      program: null,
    });
  });
});

describe("formatTabSessionInfo", () => {
  it("includes hover summary fields plus cwd and identifiers", () => {
    const tab: Tab = {
      id: "term",
      type: "terminal",
      title: "taomni",
      sessionId: "prod",
      connectionId: "conn-1",
      closable: true,
      ssh: { sessionId: "prod", host: "10.0.0.8", port: 22, username: "root", authMethod: "None", authData: null },
    };
    const text = formatTabSessionInfo(
      tab,
      [saved],
      {
        state: "running",
        program: "vite",
        backendSessionId: "runtime-1",
        activitySource: "shell-integration",
        updatedAt: 1,
      },
      "/srv/taomni",
      t,
    );
    expect(text).toContain("Title: taomni");
    expect(text).toContain("Type: terminal");
    expect(text).toContain("Connection: tabs.detailsRemote");
    expect(text).toContain("Session: Production");
    expect(text).toContain("Endpoint: root@10.0.0.8:22");
    expect(text).toContain("Host: 10.0.0.8");
    expect(text).toContain("Port: 22");
    expect(text).toContain("Username: root");
    expect(text).toContain("Group: Work / prod");
    expect(text).toContain("Session type: SSH");
    expect(text).toContain("CWD: /srv/taomni");
    expect(text).toContain("Activity: tabs.detailsRunningProgram:vite");
    expect(text).toContain("State: running");
    expect(text).toContain("Program: vite");
    expect(text).toContain("Activity source: shell-integration");
    expect(text).toContain("Tab ID: term");
    expect(text).toContain("Session ID: prod");
    expect(text).toContain("Connection ID: conn-1");
    expect(text).toContain("Backend session: runtime-1");
  });

  it("falls back when cwd is unknown for local terminals", () => {
    const tab: Tab = {
      id: "local",
      type: "terminal",
      title: "home",
      closable: true,
      localShell: { id: "pwsh", name: "PowerShell" },
    };
    const text = formatTabSessionInfo(tab, [], { state: "idle", updatedAt: 1 }, undefined, t);
    expect(text).toContain("CWD: tabs.detailsCwdUnknown");
    expect(text).toContain("Shell: PowerShell");
    expect(text).not.toContain("Endpoint:");
    expect(text).not.toContain("Session ID:");
  });
});
