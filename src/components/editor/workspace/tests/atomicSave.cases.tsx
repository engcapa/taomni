import { describe } from "vitest";
import { type registerSaveCasesFixture } from "./save.cases";
import { registeratomicSaveClipboard3Cases } from "./tests/atomicSave/clipboard3.cases";
import { registeratomicSaveHistory1Cases } from "./tests/atomicSave/history1.cases";
import { registeratomicSaveHistory2Cases } from "./tests/atomicSave/history2.cases";

export function registerAtomicSaveCases(workspaceTestHarness: registerSaveCasesFixture) {
  describe("P0-S / N1.7 Atomic Save Commit Host Race Tests", () => {
    registeratomicSaveHistory1Cases({
      get workspaceTestHarness() { return workspaceTestHarness; },
    });
    registeratomicSaveHistory2Cases({
      get workspaceTestHarness() { return workspaceTestHarness; },
    });
    registeratomicSaveClipboard3Cases({
      get workspaceTestHarness() { return workspaceTestHarness; },
    });
  });
}
