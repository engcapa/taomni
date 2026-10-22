import { type WorkspaceActionMetadata } from "../types";

export const analysisActionMetadata: Record<string, WorkspaceActionMetadata> = {
  "workspace.showCoverage":
  {
    id: "workspace.showCoverage",
    title: "Show Code Coverage",
    description: "Scan workspace and display test coverage reports and gutters",
    category: "Analyze",
    provenance: "local",
    keywords: ["coverage", "jacoco", "lcov", "gutter", "tests"],
  },
  "workspace.showAnalysis":
  {
    id: "workspace.showAnalysis",
    title: "Show Code Analysis",
    description: "Open the Problems & Analysis dock window",
    category: "Analyze",
    provenance: "local",
    keywords: ["analysis", "problems", "diagnostics", "inspections"],
  }
};
