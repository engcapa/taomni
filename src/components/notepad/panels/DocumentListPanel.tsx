import { useState } from "react";
import { Pin, X } from "lucide-react";
import { viewerTabHost } from "../../../lib/notepad/host/viewerTabHost";
import type { HostedDocRef } from "../../../lib/notepad/host/types";
import { useAppStore } from "../../../stores/appStore";
import { useDocumentStore } from "../../../stores/documentStore";
import { useExplorerStore } from "../../../stores/explorerStore";
import { useWorkspacePlatformStore } from "../../../stores/workspacePlatformStore";
import { useViewerLabels } from "../../viewer/viewerLabels";

export function DocumentListPanel({
  activeDocKey,
  onSelectDoc,
  onCloseDoc,
}: {
  activeDocKey: string;
  onSelectDoc: (doc: HostedDocRef) => void;
  onCloseDoc: (doc: HostedDocRef) => void;
}) {
  const label = useViewerLabels();
  const [sortBy, setSortBy] = useState<"order" | "name" | "dirty">("order");
  // Subscribe to all tab/document hosts so closing, renaming, pinning or
  // modifying any tab updates the Document List immediately.
  useExplorerStore((state) => state.tabs);
  useAppStore((state) => state.tabs);
  useWorkspacePlatformStore((state) => state.workspaces);
  useDocumentStore((state) => state.documents);
  const docs = viewerTabHost.listOpenDocs();

  const sorted = [...docs].sort((a, b) => {
    if (sortBy === "name") return a.title.localeCompare(b.title);
    if (sortBy === "dirty") return Number(b.dirty) - Number(a.dirty);
    return 0;
  });

  return (
    <div className="flex flex-col flex-1 min-h-0 text-[12px]" data-testid="notepad-doc-list">
      <div className="flex items-center gap-1 px-2 py-1 border-b border-[var(--taomni-divider)]">
        <span className="text-[10px] text-[var(--taomni-text-muted)]">{label("排序：", "Sort:")}</span>
        <select
          className="np-input h-6 text-[11px] flex-1"
          value={sortBy}
          onChange={(e) => setSortBy(e.target.value as "order" | "name" | "dirty")}
        >
          <option value="order">{label("打开顺序", "Tab Order")}</option>
          <option value="name">{label("文件名", "Name")}</option>
          <option value="dirty">{label("未保存优先", "Dirty First")}</option>
        </select>
      </div>
      <div className="flex-1 overflow-auto">
        {sorted.map((doc) => (
          <div
            key={`${doc.host}:${doc.tabId}`}
            data-testid={`notepad-doc-list-item-${doc.title}`}
            className={`flex items-center gap-1.5 px-2 py-1 cursor-pointer border-b border-[var(--taomni-divider)]/40 hover:bg-[var(--taomni-hover)] ${
              doc.docKey === activeDocKey ? "bg-[var(--taomni-selected)] font-medium" : ""
            }`}
            title={doc.path}
            onClick={() => onSelectDoc(doc)}
          >
            {doc.pinned && <Pin size={11} className="shrink-0 text-[var(--taomni-accent)]" />}
            <span className="truncate flex-1">{doc.title}</span>
            {doc.dirty && <span className="w-1.5 h-1.5 rounded-full bg-amber-500 shrink-0" />}
            <button
              type="button"
              className="opacity-60 hover:opacity-100"
              onClick={(e) => {
                e.stopPropagation();
                onCloseDoc(doc);
              }}
              aria-label="Close"
            >
              <X size={12} />
            </button>
          </div>
        ))}
      </div>
    </div>
  );
}
