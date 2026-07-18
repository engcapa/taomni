import { describe, expect, it } from "vitest";
import {
  buildSockscapTestTargetRequest,
  createSockscapCustomRuleDraft,
  createSockscapRuleSourceDraft,
  validateSockscapCustomRules,
  validateSockscapRuleSourceDraft,
  validateSockscapTargetDraft,
} from "./sockscapRules";

describe("Sockscap rule drafts", () => {
  it("creates custom URL and local sources without persisting local paths", () => {
    const remote = createSockscapRuleSourceDraft("custom_url", "source-remote", "Remote");
    remote.url = "https://rules.example/list.txt";
    expect(validateSockscapRuleSourceDraft(remote)).toEqual([]);
    const local = createSockscapRuleSourceDraft("local_file", "source-local", "Local");
    expect(local.url).toBeNull();
    expect(validateSockscapRuleSourceDraft(local)).toEqual([]);
  });

  it("rejects credential-bearing source URLs and incomplete manual rules", () => {
    const remote = createSockscapRuleSourceDraft("custom_url", "source-remote", "Remote");
    remote.url = "https://user:secret@rules.example/list.txt";
    expect(validateSockscapRuleSourceDraft(remote).map((issue) => issue.field)).toContain("url");
    expect(validateSockscapCustomRules([createSockscapCustomRuleDraft("rule-a")])).toHaveLength(1);
  });

  it("builds a public target request without caller-owned profiles or matchers", () => {
    const draft = {
      appIdentity: "/usr/bin/browser",
      appSelectorKind: "executable_path" as const,
      pid: 42,
      processStartTime: 99,
      target: "[2001:db8::1]",
      port: 443,
      protocol: "tcp" as const,
      hostnameSource: "ip_only" as const,
      hardBypass: false,
    };
    expect(validateSockscapTargetDraft(draft)).toEqual([]);
    expect(buildSockscapTestTargetRequest(draft)).toEqual({
      appIdentity: "/usr/bin/browser",
      appSelectorKind: "executable_path",
      pid: 42,
      processStartTime: 99,
      hostname: null,
      ip: "2001:db8::1",
      port: 443,
      protocol: "tcp",
      hostnameSource: "ip_only",
      hardBypass: false,
    });
  });

  it("requires PID and start token as one PID-reuse-safe pair", () => {
    expect(validateSockscapTargetDraft({
      appIdentity: "",
      appSelectorKind: null,
      pid: 42,
      processStartTime: null,
      target: "example.com",
      port: 443,
      protocol: "tcp",
      hostnameSource: "platform_remote_hostname",
      hardBypass: false,
    }).map((issue) => issue.field)).toEqual(["process"]);
  });
});
