import { describe, expect, it } from "vitest";
import {
  fileUriToFsPath,
  resolveWorkspaceEditPath,
} from "./codeWorkspaceModel";
import type { LspWorkspaceEdit } from "../../../lib/editor/lsp";
import { normalizeWorkspaceEditPaths } from "./workspaceEditPreview";

describe("WorkspaceEdit local path resolution", () => {
  it("decodes POSIX and Windows file URIs", () => {
    expect(fileUriToFsPath("file:///repo/src/Main.java")).toBe("/repo/src/Main.java");
    expect(fileUriToFsPath("file:///C:/repo/src/Main%20File.java")).toBe("C:/repo/src/Main File.java");
    expect(fileUriToFsPath("file://server/share/src/Main.java")).toBe("//server/share/src/Main.java");
  });

  it("binds relative provider paths to a workspace root and rejects escapes", () => {
    const roots = ["C:\\Repo"];
    expect(resolveWorkspaceEditPath("src\\Main.java", null, roots)).toBe("C:/Repo/src/Main.java");
    expect(resolveWorkspaceEditPath("../outside.java", null, roots)).toBeNull();
    expect(resolveWorkspaceEditPath(null, "jar:file:///C:/sdk.jar!/Main.class", roots)).toBeNull();
  });

  it("normalizes URI-only and relative text/resource operations consistently", () => {
    const edit: LspWorkspaceEdit = {
      documentEdits: [{
        uri: "file:///C:/Repo/src/Main.java",
        path: null,
        edits: [],
      }],
      operations: [
        {
          kind: "text",
          document: {
            uri: "file:///C:/Repo/src/Main.java",
            path: null,
            edits: [],
          },
        },
        {
          kind: "create",
          uri: "file:///C:/Repo/src/Created.java",
          path: "src/Created.java",
          overwrite: false,
          ignoreIfExists: false,
          annotationId: null,
        },
      ],
    };

    const normalized = normalizeWorkspaceEditPaths(edit, [{ path: "C:\\Repo" }]);
    expect(normalized.documentEdits[0]?.path).toBe("C:/Repo/src/Main.java");
    expect(normalized.operations?.[0]).toMatchObject({
      kind: "text",
      document: { path: "C:/Repo/src/Main.java" },
    });
    expect(normalized.operations?.[1]).toMatchObject({
      kind: "create",
      path: "C:/Repo/src/Created.java",
    });
  });
});
