// Run from repository root: node docs-issue/code-workspace-java-rename-deleted-recovery/diagnose.mjs
// In-memory diagnostic only. No application profile or project files are modified.
import { createServer } from "vite";

const server = await createServer({
  configFile: false,
  optimizeDeps: { noDiscovery: true, include: [] },
  server: { middlewareMode: true, watch: null },
  appType: "custom",
});
try {
  const { normalizeFsPath } = await server.ssrLoadModule("/src/components/editor/workspace/codeWorkspaceModel.ts");
  const { prepareRefactorRecoveryJournalV2 } = await server.ssrLoadModule("/src/components/editor/workspace/refactorPlan.ts");
  const { classifyRefactorRecoveryPreconditions } = await server.ssrLoadModule("/src/components/editor/workspace/refactorRecoveryController.ts");
  const oldPath = String.raw`D:\fixture\ique\MyTest.java`;
  const newPath = String.raw`D:\fixture\ique\MyTesting.java`;
  const oldUri = "file:///D:/fixture/ique/MyTest.java";
  const newUri = "file:///D:/fixture/ique/MyTesting.java";
  const preText = "public class MyTest {}";
  const postText = "public class MyTesting {}";
  const preparation = prepareRefactorRecoveryJournalV2({
    plan: { actionId: "diagnose-class-rename", kind: "rename" },
    edit: { documentEdits: [], operations: [
      { kind: "text", document: { uri: oldUri, path: oldPath, version: null, edits: [
        { range: { start: { line: 0, character: 13 }, end: { line: 0, character: 19 } }, newText: "MyTesting" },
      ] } },
      { kind: "rename", oldUri, newUri, oldPath, newPath, overwrite: false, ignoreIfExists: false, annotationId: null },
    ] },
    preImages: [{ uri: oldUri, canonicalPath: normalizeFsPath(oldPath), preText, encoding: "UTF-8", bom: false, eol: "lf" }],
    workspaceRoot: "D:/fixture/ique",
    transactionId: "diagnostic-only",
  });
  if (preparation.state !== "prepared") throw new Error(JSON.stringify(preparation));
  const entry = preparation.entry;
  // Reproduce the shell's current post-snapshot dictionary/alias algorithm.
  // Explicit Windows resource paths model the path shape in the user screenshot.
  const actualPostTexts = { [normalizeFsPath(newPath)]: postText };
  for (const move of entry.resourceMoves) {
    const movedText = actualPostTexts[move.newPath];
    if (movedText !== undefined && actualPostTexts[move.oldPath] === undefined) {
      actualPostTexts[move.oldPath] = movedText;
    }
  }
  const postMoveDisk = new Map([[normalizeFsPath(newPath), postText]]);
  const read = async (path) => postMoveDisk.has(normalizeFsPath(path))
    ? { text: postMoveDisk.get(normalizeFsPath(path)) } : null;
  const complete = await classifyRefactorRecoveryPreconditions(entry, read, {
    pathExists: async (path) => postMoveDisk.has(normalizeFsPath(path)),
  });
  const missing = await classifyRefactorRecoveryPreconditions(entry, async () => null, {
    pathExists: async () => false,
  });
  console.log(JSON.stringify({
    diagnosticScope: "production preparation/classifier; shell alias algorithm reproduced in memory; no native UI",
    pathLookup: {
      snapshotKey: normalizeFsPath(newPath),
      moveKey: newPath,
      movedTextFound: actualPostTexts[newPath] !== undefined,
      oldDocumentPostTextFound: actualPostTexts[entry.documents[0].canonicalPath] !== undefined,
    },
    completedTextAndMove: { overall: complete.overall, document: complete.documents[0].state, move: complete.moves[0].state },
    bothFilesDeleted: { overall: missing.overall, document: missing.documents[0].state, move: missing.moves[0].state },
  }, null, 2));
} finally {
  await server.close();
}
