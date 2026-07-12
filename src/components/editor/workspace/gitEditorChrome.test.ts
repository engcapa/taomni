import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { describe, expect, it } from "vitest";
import type { GitBlameLine } from "../../../lib/git";
import { blameLabel, buildGitLineChanges, createGitEditorChrome, formatBlameAge } from "./gitEditorChrome";

describe("gitEditorChrome", () => {
  it("builds added, modified, and deleted line hunks against HEAD", () => {
    const changes = buildGitLineChanges(
      "one\ntwo\nthree\nfour",
      "one\nTWO\ninserted\nfour",
    );
    expect(changes.map((change) => change.kind)).toEqual(["modified"]);
    expect(changes[0].oldText).toContain("two");
    expect(changes[0].newText).toContain("TWO");

    expect(buildGitLineChanges("one\n", "one\ntwo\n")[0].kind).toBe("added");
    expect(buildGitLineChanges("one\ntwo\n", "one\n")[0].kind).toBe("deleted");
  });

  it("renders clickable gutter marks and an inline blame widget", () => {
    const parent = document.createElement("div");
    document.body.appendChild(parent);
    const blame: GitBlameLine = {
      line: 2,
      commit: "0123456789abcdef",
      author: "Ada",
      authorMail: "ada@example.test",
      authorTime: 1_783_814_400,
      summary: "feat: add gutter",
    };
    const view = new EditorView({
      parent,
      state: EditorState.create({
        doc: "one\ntwo",
        extensions: createGitEditorChrome(buildGitLineChanges("one\nold", "one\ntwo"), blame),
      }),
    });
    expect(parent.querySelector(".cm-git-change-gutter")).toBeTruthy();
    expect(parent.querySelector(".cm-git-change-modified")).toBeTruthy();
    expect(parent.querySelector(".cm-inline-git-blame")?.textContent).toContain("Ada");
    view.destroy();
    parent.remove();
  });

  it("formats blame ages and uncommitted lines", () => {
    expect(formatBlameAge(1_000, 1_000_000 + 90 * 60_000)).toBe("1h ago");
    expect(blameLabel({
      line: 1,
      commit: "0000000000000000000000000000000000000000",
      author: "Not Committed Yet",
      authorMail: null,
      authorTime: 0,
      summary: "draft",
    })).toBe("Uncommitted change");
  });
});
