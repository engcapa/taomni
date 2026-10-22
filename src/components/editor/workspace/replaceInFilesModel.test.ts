import "./tests/replaceInFilesModel/harness";
import { describe } from "vitest";
import { buildReplaceInFilesWorkspaceEdit, replaceEditSignature, replaceMatchStableKey, type ReplaceInFilesMatch, type ReplacePreviewSnapshot } from "./replaceInFilesModel";
import { registerreplaceInFilesModelBehavior2Cases } from "./tests/replaceInFilesModel/behavior2.cases";
import { registerreplaceInFilesModelCompletion3Cases } from "./tests/replaceInFilesModel/completion3.cases";
import { registerreplaceInFilesModelEditing1Cases } from "./tests/replaceInFilesModel/editing1.cases";
import { registerreplaceInFilesModelEditing4Cases } from "./tests/replaceInFilesModel/editing4.cases";
import { registerreplaceInFilesModelEditing5Cases } from "./tests/replaceInFilesModel/editing5.cases";

registerreplaceInFilesModelEditing1Cases();

registerreplaceInFilesModelBehavior2Cases();

// ---------------------------------------------------------------------------
// ED-IMPROVE-005: the frozen preview snapshot is the commit's single source
// of truth for scope, query, replacement, selected matches and edit identity.
// ---------------------------------------------------------------------------
describe("ED-IMPROVE-005: frozen replace preview snapshot", () => {
  const sampleMatches: ReplaceInFilesMatch[] = [
    { filePath: "/ws/A.java", startLine: 1, startCharacter: 2, endLine: 1, endCharacter: 5, matchedText: "foo" },
    { filePath: "/ws/B.java", startLine: 3, startCharacter: 0, endLine: 3, endCharacter: 3, matchedText: "foo" },
    { filePath: "/ws/test/A.test.java", startLine: 0, startCharacter: 4, endLine: 0, endCharacter: 7, matchedText: "foo" },
  ];

  function snapshotFor(edit: ReturnType<typeof buildReplaceInFilesWorkspaceEdit>): ReplacePreviewSnapshot {
    return {
      scope: {
        kind: "project",
        roots: ["/ws"],
        explicitFiles: [],
        fileMask: "*.java",
        generation: 3,
      },
      query: {
        query: "foo",
        caseSensitive: false,
        wholeWord: false,
        regexp: false,
        includeGlobs: ["**/*.java"],
        excludeGlobs: ["*.test.java"],
      },
      replacement: "bar",
      matchKeys: sampleMatches.map(replaceMatchStableKey),
      matchCount: sampleMatches.length,
      editSignature: replaceEditSignature(edit),
      capturedAt: 1,
    };
  }
  registerreplaceInFilesModelCompletion3Cases({
    get sampleMatches() { return sampleMatches; },
    get snapshotFor() { return snapshotFor; },
  });
  registerreplaceInFilesModelEditing4Cases({
    get sampleMatches() { return sampleMatches; },
  });
  registerreplaceInFilesModelEditing5Cases();
});
