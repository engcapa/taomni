import { LayoutGrid, List } from "lucide-react";
import { formatBytes, type FileEntry } from "../../lib/sftp";
import { setExplorerPreferences, useExplorerPreferences } from "./explorerPreferences";
import { useExplorerLabels } from "./explorerLabels";

export function ExplorerStatusBar({ entries, selected }: { entries: FileEntry[]; selected: FileEntry[] }) {
  const label = useExplorerLabels();
  const preferences = useExplorerPreferences();
  return <div className="ex-status" data-testid="explorer-status" role="status">
    <span>{label(`${entries.length} 个项目`, `${entries.length} items`)}</span>
    {selected.length > 0 && <span>{label(`已选择 ${selected.length} 项`, `${selected.length} selected`)} · {formatBytes(selected.reduce((sum, entry) => sum + (entry.fileType === "dir" ? 0 : entry.size), 0))}</span>}
    <span className="ex-sp" />
    <button className={`ex-ibtn ${preferences.view !== "icons" ? "on" : ""}`} title={label("详细信息", "Details")} aria-label={label("详细信息", "Details")} onClick={() => setExplorerPreferences({ view: "details" })}><List /></button>
    <button className={`ex-ibtn ${preferences.view === "icons" ? "on" : ""}`} title={label("大图标", "Large icons")} aria-label={label("大图标", "Large icons")} onClick={() => setExplorerPreferences({ view: "icons" })}><LayoutGrid /></button>
  </div>;
}
