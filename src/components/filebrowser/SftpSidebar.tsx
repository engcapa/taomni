import { useEffect, useCallback, useState } from "react";
import { FilePanel } from "./FilePanel";
import { FileTransferQueue } from "./FileTransferQueue";
import { useSftpStore } from "../../stores/sftpStore";
import { useSftpController } from "../../lib/sftpController";
import { type FileEntry, joinPath } from "../../lib/sftp";
import type { MenuItem } from "../ContextMenu";
import { useAppStore } from "../../stores/appStore";
import { Maximize2, X } from "lucide-react";

interface SftpSidebarProps {
  sessionId: string;
  host: string;
  port: number;
  username: string;
  authMethod: string;
  authData: string | null;
  cwdHint?: string | null;
  onClose?: () => void;
  onDetach?: () => void;
  title?: string;
}

export function SftpSidebar(props: SftpSidebarProps) {
  const session = useSftpStore((s) => s.sessions[props.sessionId]);
  const ensureSession = useSftpStore((s) => s.ensureSession);
  const attach = useSftpStore((s) => s.attach);
  const navigate = useSftpStore((s) => s.navigate);
  const setStatus = useAppStore((s) => s.setStatusMessage);
  const controller = useSftpController(props.sessionId);
  const [downloadPrompt, setDownloadPrompt] = useState<FileEntry | null>(null);

  useEffect(() => {
    ensureSession(props.sessionId);
    if (!session?.attached && !session?.attaching) {
      attach({
        sessionId: props.sessionId,
        host: props.host,
        port: props.port,
        username: props.username,
        authMethod: props.authMethod,
        authData: props.authData,
      }).catch((err) => setStatus(`SFTP attach failed: ${err}`));
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.sessionId]);

  useEffect(() => {
    if (!props.cwdHint || !session?.attached) return;
    if (session.remote.path === props.cwdHint) return;
    void navigate(props.sessionId, "remote", props.cwdHint);
  }, [props.cwdHint, props.sessionId, session?.attached, session?.remote.path, navigate]);

  const remoteContext = useCallback(
    (entry: FileEntry): MenuItem[] => {
      const items: MenuItem[] = [];
      if (entry.fileType === "file") {
        items.push({
          label: "Download to local",
          onClick: () => {
            const localDir = session?.local.path ?? "";
            void controller.download(entry, localDir);
          },
        });
        items.push({
          label: "Download and open",
          onClick: () => {
            const localDir = session?.local.path ?? "";
            void controller.download(entry, localDir, { openAfter: true });
          },
        });
      }
      items.push({
        label: "Rename",
        onClick: () => {
          const next = window.prompt("Rename to", entry.name);
          if (next && next !== entry.name) void controller.rename(entry.path, next, "remote");
        },
      });
      items.push({
        label: "Delete",
        onClick: () => {
          if (window.confirm(`Delete remote: ${entry.name}?`)) {
            void controller.remove(entry.path, "remote", true);
          }
        },
        danger: true,
      });
      return items;
    },
    [controller, session?.local.path],
  );

  const remoteEmptyContext = useCallback(
    (): MenuItem[] => [
      {
        label: "New folder…",
        onClick: () => {
          const name = window.prompt("New folder name", "new-folder");
          if (name) void controller.mkdir(session?.remote.path ?? "/", name, "remote");
        },
      },
    ],
    [controller, session?.remote.path],
  );

  const handleFiles = useCallback(
    async (files: File[]) => {
      const remoteDir = session?.remote.path ?? "/";
      for (const file of files) {
        await controller.uploadBlob(remoteDir, file);
      }
    },
    [controller, session?.remote.path],
  );

  return (
    <div className="h-full flex flex-col min-h-0" style={{ background: "var(--moba-bg)" }}>
      <div className="h-6 px-2 flex items-center text-[11px] font-semibold border-b"
        style={{ borderColor: "var(--moba-divider)", background: "var(--moba-quick-bg)" }}>
        <span className="truncate">{props.title ?? "SFTP"}</span>
        <div className="flex-1" />
        {props.onDetach && (
          <button
            type="button"
            className="px-1 hover:bg-[var(--moba-hover)] rounded"
            title="Open in its own tab"
            onClick={props.onDetach}
          >
            <Maximize2 className="w-3 h-3" />
          </button>
        )}
        {props.onClose && (
          <button
            type="button"
            className="px-1 hover:bg-[var(--moba-hover)] rounded"
            title="Hide SFTP sidebar"
            onClick={props.onClose}
          >
            <X className="w-3 h-3" />
          </button>
        )}
      </div>

      {session?.attaching && (
        <div className="px-2 py-1 text-[11px]" style={{ color: "var(--moba-text-muted)" }}>
          Attaching SFTP channel…
        </div>
      )}
      {session?.error && (
        <div className="px-2 py-1 text-[11px]" style={{ color: "#7a1f0a" }}>
          {session.error}
        </div>
      )}

      <div className="flex-1 min-h-0 flex flex-col">
        <FilePanel
          sessionId={props.sessionId}
          side="remote"
          title={`Remote — ${session?.remote.path ?? "—"}`}
          onItemDoubleClick={(entry) => {
            if (entry.fileType === "dir") {
              void navigate(props.sessionId, "remote", entry.path);
            } else {
              setDownloadPrompt(entry);
            }
          }}
          onItemContext={remoteContext}
          onEmptyContext={remoteEmptyContext}
          onPaneFiles={handleFiles}
        />
      </div>
      <FileTransferQueue
        sessionId={props.sessionId}
        onCancel={(id) => void controller.cancelTransfer(id)}
        compact
      />

      {downloadPrompt && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center"
          style={{ background: "rgba(0,0,0,0.4)" }}
          onClick={() => setDownloadPrompt(null)}
        >
          <div
            className="w-[420px] rounded shadow-lg p-4"
            style={{ background: "var(--moba-bg)", border: "1px solid var(--moba-card-border)" }}
            onClick={(e) => e.stopPropagation()}
          >
            <div className="text-sm font-semibold mb-2">Open remote file?</div>
            <div className="text-[12px] mb-3 break-all" style={{ color: "var(--moba-text-muted)" }}>
              {downloadPrompt.name} will be saved to:
              <div className="mt-1 font-mono text-[11px]">
                {joinPath(session?.local.path ?? "", downloadPrompt.name)}
              </div>
            </div>
            <div className="flex gap-2 justify-end">
              <button type="button" className="px-3 py-1 text-[12px] rounded hover:bg-[var(--moba-hover)]"
                onClick={() => setDownloadPrompt(null)}>Cancel</button>
              <button type="button" className="px-3 py-1 text-[12px] rounded hover:bg-[var(--moba-hover)]"
                onClick={() => {
                  void controller.download(downloadPrompt, session?.local.path ?? "", { openAfter: false });
                  setDownloadPrompt(null);
                }}>Download only</button>
              <button type="button" className="px-3 py-1 text-[12px] rounded text-white"
                style={{ background: "var(--moba-accent)" }}
                onClick={() => {
                  void controller.download(downloadPrompt, session?.local.path ?? "", { openAfter: true });
                  setDownloadPrompt(null);
                }}>Download &amp; open</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
