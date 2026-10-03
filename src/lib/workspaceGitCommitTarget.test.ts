import { describe, expect, it } from "vitest";
import type { GitBranch, GitSnapshot } from "./git";
import {
  collectLocalBranchNames,
  formatCommitBranchPlanLine,
  resolveCommitBranchPlan,
} from "./workspaceGitCommitTarget";

function branch(name: string, remote = false): GitBranch {
  return {
    name,
    fullName: remote ? `refs/remotes/origin/${name}` : `refs/heads/${name}`,
    current: name === "main" && !remote,
    remote,
    upstream: null,
    oid: "abc",
    subject: "s",
  };
}

function snap(current: string | null, branches: GitBranch[]): Pick<GitSnapshot, "currentBranch" | "branches" | "detached"> {
  return { currentBranch: current, branches, detached: !current };
}

describe("resolveCommitBranchPlan", () => {
  it("stays on current when target empty or equal", () => {
    const snapshot = snap("main", [branch("main"), branch("feature")]);
    expect(resolveCommitBranchPlan(snapshot, "")).toEqual({
      targetBranch: "main",
      action: "stay",
      currentBranch: "main",
    });
    expect(resolveCommitBranchPlan(snapshot, "main").action).toBe("stay");
  });

  it("plans checkout when the branch already exists", () => {
    const snapshot = snap("main", [branch("main"), branch("feature")]);
    expect(resolveCommitBranchPlan(snapshot, "feature")).toEqual({
      targetBranch: "feature",
      action: "checkout",
      currentBranch: "main",
    });
  });

  it("plans create when the branch does not exist", () => {
    const snapshot = snap("main", [branch("main")]);
    expect(resolveCommitBranchPlan(snapshot, " brand-new ".trim())).toEqual({
      targetBranch: "brand-new",
      action: "create",
      currentBranch: "main",
    });
  });

  it("ignores remote-only names for existence (creates local branch)", () => {
    const snapshot = snap("main", [branch("main"), branch("origin/feature", true)]);
    // Remote branch named with remote prefix — local name "feature" still creates.
    expect(resolveCommitBranchPlan(snapshot, "feature").action).toBe("create");
  });
});

describe("formatCommitBranchPlanLine", () => {
  it("describes stay/checkout/create", () => {
    expect(formatCommitBranchPlanLine("app", {
      targetBranch: "main",
      action: "stay",
      currentBranch: "main",
    })).toContain("current");
    expect(formatCommitBranchPlanLine("app", {
      targetBranch: "feature",
      action: "checkout",
      currentBranch: "main",
    })).toContain("checkout");
    expect(formatCommitBranchPlanLine("app", {
      targetBranch: "x",
      action: "create",
      currentBranch: "main",
    })).toContain("create");
  });
});

describe("collectLocalBranchNames", () => {
  it("unions local branch names across repos", () => {
    const names = collectLocalBranchNames([
      snap("main", [branch("main"), branch("a")]),
      snap("develop", [branch("develop"), branch("a"), branch("origin/x", true)]),
    ]);
    expect(names).toEqual(["a", "develop", "main"]);
  });
});
