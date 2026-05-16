import { useCallback, useEffect, useState } from "react";
import { FilePanel } from "./FilePanel";
import { ChmodDialog } from "./ChmodDialog";
import { useSftpStore } from "../../stores/sftpStore";
import { useSftpController } from "../../lib/sftpController";
import { sftpOpenPath, type FileEntry } from "../../lib/sftp";
import { useAppStore } from "../../stores/appStore";
import type { MenuItem } from "../ContextMenu";

interface Props {
  /** Stable id used to namespace this tab's pane state in `sftpStore`. */
  tabId: string;
  initialPath: string;
}

/**
 * Single-pane local file browser used by File-type sessions. Reuses the
 * same `FilePanel` (toolbar, sortable columns, breadcrumb, hidden toggle,
 * filter box) as the SFTP browser's local pane — wiring the LOCAL side of
 * a synthetic store entry that has no remote channel attached.
 */
export function LocalFileBrowserPanel({ tabId, initialPath }: Props) {
  const session = useSftpStore((s) => s.sessions[tabId]);
  const attachLocalOnly = useSftpStore((s) => s.attachLocalOnly);
  const detachLocalOnly = useSftpStore((s) => s.detachLocalOnly);
  const navigate = useSftpStore((s) => s.navigate);
  const setStatus = useAppStore((s) => s.setStatusMessage);
  const controller = useSftpController(tabId);

  const [chmodPrompt, setChmodPrompt] = useState<{ entries: FileEntry[] } | null>(null);
  const [filterText, setFilterText] = useState("");

  useEffect(() => {
    if (!session?.attached) {
      void attachLocalOnly(tabId, initialPath);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tabId]);

  useEffect(() => {
    return () => {
      detachLocalOnly(tabId);
    };
  }, [tabId, detachLocalOnly]);

  const handleOpen = useCallback(async (entries: FileEntry[]) => {
    for (const entry of entries) {
      if (entry.fileType === "dir") {
        await navigate(tabId, "local", entry.path);
        return;
      }
      try {
        await sftpOpenPath(entry.path);
      } catch (err) {
        setStatus(`Failed to open ${entry.name}: ${err}`);
      }
    }
  }, [navigate, setStatus, tabId]);

  const handleDoubleClick = useCallback(async (entry: FileEntry) => {
    if (entry.fileType === "dir") {
      await navigate(tabId, "local", entry.path);
      return;
    }
    try {
      await sftpOpenPath(entry.path);
    } catch (err) {
      setStatus(`Failed to open ${entry.name}: ${err}`);
    }
  }, [navigate, setStatus, tabId]);

  const localContext = useCallback(
    (entry: FileEntry, _anchor: { x: number; y: number }, selectedEntries: FileEntry[]): MenuItem[] => {
      const targets = selectedEntries.length > 0 ? selectedEntries : [entry];
      const target = targets[0] ?? entry;
      const multi = targets.length > 1;
      const items: MenuItem[] = [];
      items.push({
        label: entry.fileType === "dir"
          ? "Open folder"
          : multi
            ? `Open ${targets.length} files`
            : "Open",
        onClick: () => void handleOpen(targets),
      });
      if (!multi) {
        items.push({
          label: "Reveal in OS file manager",
          onClick: () => {
            const path = target.fileType === "dir" ? target.path : (session?.local.path ?? "");
            void sftpOpenPath(path).catch((err) => setStatus(`Open failed: ${err}`));
          },
        });
      }
      if (!multi) {
        items.push({
          label: "Rename",
          onClick: () => {
            const next = window.prompt("Rename to", target.name);
            if (next && next !== target.name) {
              void controller.rename(target.path, next, "local");
            }
          },
        });
      }
      items.push({
        label: multi ? `Permissions for ${targets.length} selected…` : "Permissions…",
        onClick: () => setChmodPrompt({ entries: targets }),
      });
      items.push({
        label: multi ? `Delete ${targets.length} selected` : "Delete",
        onClick: () => {
          const summary = multi ? `${targets.length} items` : target.name;
          if (window.confirm(`Delete ${summary}?`)) {
            for (const item of targets) {
              void controller.remove(item.path, "local", true);
            }
          }
        },
        danger: true,
      });
      return items;
    },
    [controller, handleOpen, session?.local.path, setStatus],
  );

  const localEmptyContext = useCallback(
    (): MenuItem[] => [
      {
        label: "New folder…",
        onClick: () => {
          const name = window.prompt("New folder name", "new-folder");
          if (name) void controller.mkdir(session?.local.path ?? "", name, "local");
        },
      },
      {
        label: "New file…",
        onClick: () => {
          const name = window.prompt("New file name", "new-file.txt");
          if (name) void controller.createFile(session?.local.path ?? "", name, "local");
        },
      },
      {
        label: "Refresh",
        onClick: () => {
          void useSftpStore.getState().refreshPane(tabId, "local");
        },
      },
      {
        label: "Open current folder in OS",
        onClick: () => {
          void sftpOpenPath(session?.local.path ?? "")
            .catch((err) => setStatus(`Open failed: ${err}`));
        },
      },
    ],
    [controller, session?.local.path, setStatus, tabId],
  );

  if (!session?.attached) {
    return (
      <div
        className="w-full h-full flex items-center justify-center text-[12px]"
        style={{ background: "var(--moba-bg)", color: "var(--moba-text-muted)" }}
      >
        Loading file browser…
      </div>
    );
  }

  return (
    <div className="w-full h-full flex flex-col" style={{ background: "var(--moba-bg)" }}>
      <FilePanel
        sessionId={tabId}
        side="local"
        onItemDoubleClick={(e) => void handleDoubleClick(e)}
        onItemContext={localContext}
        onEmptyContext={localEmptyContext}
        onOpenLocalSelected={(entries) => void handleOpen(entries)}
        onRevealInOs={(path) => {
          if (!path) return;
          void sftpOpenPath(path).catch((err) => setStatus(`Open failed: ${err}`));
        }}
        filterText={filterText}
        onFilterTextChange={setFilterText}
        onDeleteSelected={(entries) => {
          if (entries.length === 0) return;
          const summary = entries.length === 1
            ? entries[0].name
            : `${entries.length} items`;
          if (!window.confirm(`Delete ${summary}?`)) return;
          for (const entry of entries) {
            void controller.remove(entry.path, "local", true);
          }
        }}
        onChmodSelected={(entries) => {
          if (entries.length === 0) return;
          setChmodPrompt({ entries });
        }}
        onNewFile={() => {
          const name = window.prompt("New file name", "new-file.txt");
          if (name) void controller.createFile(session?.local.path ?? "", name, "local");
        }}
      />

      {chmodPrompt && (
        <ChmodDialog
          entries={chmodPrompt.entries}
          onCancel={() => setChmodPrompt(null)}
          onApply={(mode, recursive) => {
            for (const entry of chmodPrompt.entries) {
              if (recursive && entry.fileType === "dir") {
                void controller.chmodRecursive(entry.path, mode, "local");
              } else {
                void controller.chmod(entry.path, mode, "local");
              }
            }
            setChmodPrompt(null);
          }}
        />
      )}
    </div>
  );
}
