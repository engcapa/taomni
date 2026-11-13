import { ExplorerFileIcon } from "./ExplorerFileIcon";
import "./explorerTabIcon.css";

/** The same prototype folder identifies Explorer in main and workspace tabs. */
export function ExplorerTabIcon() {
  return <ExplorerFileIcon directory className="taomni-explorer-tab-icon h-3.5 w-3.5 shrink-0" />;
}
