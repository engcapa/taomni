import { FileBrowser, type SftpPendingUploadRequest } from "./FileBrowser";
import { useT } from "../../lib/i18n";

interface SftpSidebarProps {
  sessionId: string;
  host: string;
  port: number;
  username: string;
  authMethod: string;
  authData: string | null;
  networkSettingsJson?: string | null;
  cwdHint?: string | null;
  cwdHintVersion?: number;
  onRequestTerminalCwd?: () => boolean;
  onClose?: () => void;
  onDetach?: () => void;
  onOpenTerminalHere?: (path: string) => void;
  title?: string;
  pendingUploadRequest?: SftpPendingUploadRequest | null;
  onPendingUploadRequestHandled?: (requestId: number) => void;
}

/**
 * Thin wrapper around <FileBrowser/> that renders the dual-pane SFTP UI in
 * a narrow sidebar. Defaults to a stacked (vertical) layout because the
 * sidebar is only ~380px wide; the user can flip to side-by-side via the
 * orientation toggle in the header.
 *
 * Cwd sync is delegated to <FileBrowser/> and is strictly user-triggered:
 * the panel only asks the terminal for cwd when the explicit Sync button is clicked.
 */
export function SftpSidebar(props: SftpSidebarProps) {
  const t = useT();
  return (
    <FileBrowser
      sessionId={props.sessionId}
      host={props.host}
      port={props.port}
      username={props.username}
      authMethod={props.authMethod}
      authData={props.authData}
      networkSettingsJson={props.networkSettingsJson ?? null}
      cwdHint={props.cwdHint}
      cwdHintVersion={props.cwdHintVersion}
      onRequestTerminalCwd={props.onRequestTerminalCwd}
      onDetach={props.onDetach}
      onClose={props.onClose}
      onOpenTerminalHere={props.onOpenTerminalHere}
      pendingUploadRequest={props.pendingUploadRequest}
      onPendingUploadRequestHandled={props.onPendingUploadRequestHandled}
      showHeader
      title={props.title ?? t("fileBrowser.sftpHeaderDefaultTitle")}
      defaultOrientation="vertical"
      orientationScope={`sidebar-${props.sessionId}`}
    />
  );
}
