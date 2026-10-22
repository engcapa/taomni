import { useCallback, useState } from "react";
import { workspaceReadFile } from "../../../../lib/editor/workspace";
import type { CodeWorkspaceRootInfo } from "../../../../types";
import { parseCoverageReport, type WorkspaceCoverageReport } from "../coverageModel";


export interface UseWorkspaceCoverageContext {
  rootsRef: import("react").RefObject<CodeWorkspaceRootInfo[]>;
  setStatusMessage: (message: string) => void;
}

export function useWorkspaceCoverage(context: UseWorkspaceCoverageContext) {
  const { rootsRef, setStatusMessage } = context;

  const [coverageReport, setCoverageReport] = useState<WorkspaceCoverageReport | null>(null);
  const [coverageOverlayEnabled, setCoverageOverlayEnabled] = useState(true);

  const scanWorkspaceCoverage = useCallback(async () => {
    for (const root of rootsRef.current) {
      const candidates = [
        "coverage/lcov.info",
        "lcov.info",
        "target/site/jacoco/jacoco.xml",
        "target/site/jacoco-aggregate/jacoco.xml",
        "build/reports/jacoco/test/jacocoTestReport.xml",
        "coverage.xml",
      ];
      for (const rel of candidates) {
        try {
          const file = await workspaceReadFile(root.path, rel);
          if (file && file.text) {
            const report = parseCoverageReport(file.text);
            setCoverageReport(report);
            setStatusMessage(`Loaded test coverage (${rel}): ${report.totalPercentage}% covered`);
            return;
          }
        } catch {
          // Continue searching candidates
        }
      }
    }
    setStatusMessage("No coverage reports found (run tests with coverage enabled)");
  }, [setStatusMessage]);
  return { coverageReport, scanWorkspaceCoverage, coverageOverlayEnabled, setCoverageOverlayEnabled };
}
