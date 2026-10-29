import type { ReactNode } from "react";

/** Construct a tool's props inside its keep-alive boundary, away from file activation. */
export interface ToolWindowContent {
  id: string;
  label: string;
  content?: ReactNode;
  renderContent?: () => ReactNode;
}
