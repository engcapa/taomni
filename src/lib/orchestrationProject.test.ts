import { describe, expect, it } from "vitest";
import { agentProjectKey, sameAgentProject } from "./orchestrationProject";

describe("native agent project identity", () => {
  it("matches canonical Windows drive and UNC paths to workspace display paths", () => {
    expect(sameAgentProject("\\\\?\\C:\\Users\\QA\\project", "C:/Users/QA/project")).toBe(true);
    expect(sameAgentProject("//?/C:/Users/QA/project", "c:/users/qa/project/")).toBe(true);
    expect(sameAgentProject("\\\\?\\UNC\\server\\share\\repo", "//server/share/repo")).toBe(true);
    expect(sameAgentProject("C:/work/a", "C:/work/b")).toBe(false);
    expect(sameAgentProject("C:/work/a", "D:/work/a")).toBe(false);
  });
  it("preserves POSIX case and does not resolve symlinks or alter execution paths", () => {
    expect(agentProjectKey("/")).toBe("/");
    expect(sameAgentProject("/project/", "/project")).toBe(true);
    expect(sameAgentProject("/project/A", "/project/a")).toBe(false);
    expect(sameAgentProject("/project/link", "/real/project")).toBe(false);
  });
});
