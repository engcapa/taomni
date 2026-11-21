import { describe, expect, it } from "vitest";
import {
  clonePhaseTitleKey,
  deriveRepoNameFromUrl,
  isAbsoluteClonePath,
  joinClonePath,
  validateBranchName,
  validateCloneUrl,
  validateWorkspaceName,
} from "./gitClone";

describe("git clone URL derivation", () => {
  it("derives repository names from supported URL shapes", () => {
    expect(deriveRepoNameFromUrl("https://github.com/engcapa/taomni.git")).toBe("taomni");
    expect(deriveRepoNameFromUrl("https://github.com/engcapa/taomni/")).toBe("taomni");
    expect(deriveRepoNameFromUrl("git@github.com:engcapa/taomni.git")).toBe("taomni");
    expect(deriveRepoNameFromUrl("ssh://git@example.test/org/repo.git")).toBe("repo");
    expect(deriveRepoNameFromUrl("file:///C:/work/My%20Repo.git")).toBe("My Repo");
    expect(deriveRepoNameFromUrl("C:\\work\\company\\repo")).toBe("repo");
    expect(deriveRepoNameFromUrl("/home/user/repo.git")).toBe("repo");
    expect(deriveRepoNameFromUrl("")).toBe("repository");
  });
});

describe("git clone URL validation", () => {
  it("accepts HTTPS, SSH, scp-like and absolute local paths", () => {
    expect(validateCloneUrl("https://github.com/engcapa/taomni.git")).toBeNull();
    expect(validateCloneUrl("ssh://git@example.test/org/repo.git")).toBeNull();
    expect(validateCloneUrl("git@github.com:engcapa/taomni.git")).toBeNull();
    expect(validateCloneUrl("file:///C:/work/repo.git")).toBeNull();
    expect(validateCloneUrl("C:\\work\\repo")).toBeNull();
    expect(validateCloneUrl("/home/user/repo")).toBeNull();
  });

  it("rejects missing, embedded-credential, whitespace and option-like values", () => {
    expect(validateCloneUrl("   ")).toBe("required");
    expect(validateCloneUrl("--upload-pack=evil")).toBe("invalid");
    expect(validateCloneUrl("https://token@github.com/org/repo.git")).toBe("credentials");
    expect(validateCloneUrl("https://user:pass@github.com/org/repo.git")).toBe("credentials");
    expect(validateCloneUrl("https://example.test/repo with space.git")).toBe("whitespace");
    expect(validateCloneUrl("ftp://example.test/repo.git")).toBe("invalid");
    expect(validateCloneUrl("not-a-url")).toBe("invalid");
  });
});

describe("git clone form validation", () => {
  it("validates branch names with Git ref constraints", () => {
    expect(validateBranchName("")).toBeNull();
    expect(validateBranchName("feature/clone-import")).toBeNull();
    expect(validateBranchName("release.2026")).toBeNull();
    expect(validateBranchName("-bad")).toBe("invalid");
    expect(validateBranchName("a..b")).toBe("invalid");
    expect(validateBranchName("a b")).toBe("invalid");
    expect(validateBranchName("a@{b")).toBe("invalid");
    expect(validateBranchName("a~b")).toBe("invalid");
  });

  it("validates workspace names and absolute parent paths", () => {
    expect(validateWorkspaceName("taomni-clone")).toBeNull();
    expect(validateWorkspaceName("")).toBe("required");
    expect(validateWorkspaceName("a/b")).toBe("invalid");
    expect(validateWorkspaceName("..")).toBe("invalid");
    expect(isAbsoluteClonePath("C:\\work")).toBe(true);
    expect(isAbsoluteClonePath("/home/user")).toBe(true);
    expect(isAbsoluteClonePath("relative/path")).toBe(false);
  });

  it("joins the destination preview using the parent separator style", () => {
    expect(joinClonePath("C:\\Users\\me\\taomni-workspaces", "repo")).toBe(
      "C:\\Users\\me\\taomni-workspaces\\repo",
    );
    expect(joinClonePath("/home/me/taomni-workspaces/", "repo")).toBe(
      "/home/me/taomni-workspaces/repo",
    );
    expect(joinClonePath("", "repo")).toBe("repo");
  });

  it("maps every clone phase to a translation key", () => {
    expect(clonePhaseTitleKey("receiving")).toBe("gitClone.phaseReceiving");
    expect(clonePhaseTitleKey("cancelling")).toBe("gitClone.phaseCancelling");
    expect(clonePhaseTitleKey("idle")).toBe("gitClone.phaseIdle");
  });
});
