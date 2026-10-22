import { useWorkspaceAnnouncements } from "../hooks/useWorkspaceAnnouncements";
import { useWorkspaceClipboard } from "../hooks/useWorkspaceClipboard";
import { useWorkspaceUiActions } from "../hooks/useWorkspaceUiActions";


export interface WorkspaceOperationObservationsProps {
  announcements: ReturnType<typeof useWorkspaceAnnouncements>;
  activeFile: import("../editorGroupTypes").OpenFileViewModel | null;
  uiActions: ReturnType<typeof useWorkspaceUiActions>;
  clipboard: ReturnType<typeof useWorkspaceClipboard>;
}

export function WorkspaceOperationObservations(props: WorkspaceOperationObservationsProps) {
  const { announcements, activeFile, uiActions, clipboard } = props;
  return (<><div
    id="code-workspace-save-observation"
    data-testid="code-workspace-save-observation"
    role="status"
    aria-label="Save status"
    aria-live="polite"
    aria-atomic="true"
    data-state={announcements.activeSaveObservationState}
    data-result-kind={announcements.latestSaveObservation?.resultKind}
    data-disk-effect={announcements.latestSaveObservation?.diskEffect}
    data-memory-effect={announcements.latestSaveObservation?.memoryEffect}
    data-provider-effect={announcements.latestSaveObservation?.providerEffect}
    data-file-path={announcements.latestSaveObservation?.filePath}
    data-uri={announcements.latestSaveObservation?.uri}
    data-buffer-revision={activeFile?.documentRevision ?? announcements.latestSaveObservation?.bufferRevision}
    data-dirty={activeFile?.dirty ?? announcements.latestSaveObservation?.isDirty ?? false}
    data-receipt-id={announcements.activeSaveReceipt?.receiptId}
    data-transaction-id={announcements.activeSaveReceipt?.transactionId ?? announcements.latestSaveObservation?.transactionId}
    data-final-text-sha256={announcements.activeSaveReceipt?.finalTextSha256}
    data-encoded-bytes-sha256={announcements.activeSaveReceipt?.encodedBytesSha256}
    data-encoded-byte-length={announcements.activeSaveReceipt?.encodedByteLength}
    data-disk-pre-sha256={announcements.activeSaveReceipt?.diskPreSha256 ?? undefined}
    data-disk-post-sha256={announcements.activeSaveReceipt?.diskPostSha256}
    data-write-count={announcements.activeSaveReceipt?.writeCount}
    data-encoding={announcements.activeSaveReceipt?.policy.encoding}
    data-bom={announcements.activeSaveReceipt ? String(announcements.activeSaveReceipt.policy.bom) : undefined}
    data-eol={announcements.activeSaveReceipt?.policy.eol}
    data-history-id={announcements.activeSaveReceipt?.historyId}
    data-recovery-id={announcements.latestSaveObservation?.recoverySnapshotId ?? announcements.activeSaveReceipt?.recoveryId}
    data-verified-at={announcements.latestSaveObservation?.lastVerifiedAt}
    className="sr-only"
  >
    {announcements.activeSaveAnnouncement}
  </div>
    {/*
          ED-CLIP-004 clipboard observation seam. Metadata only: outcome, OS
          effect, permission epoch, payload SHAPE and caret count. Never the
          copied text — a runner must not be able to reconstruct the payload
          from the DOM.
        */}
    <div
      id="code-workspace-clipboard-observation"
      data-testid="code-workspace-clipboard-observation"
      role="status"
      aria-label="Clipboard status"
      aria-live="polite"
      aria-atomic="true"
      data-operation={uiActions.latestClipboardObservation?.operation}
      data-outcome={uiActions.latestClipboardObservation?.outcome}
      data-system-effect={uiActions.latestClipboardObservation?.systemEffect}
      data-permission={uiActions.latestClipboardObservation?.permission ?? clipboard.clipboardSnapshot.permission}
      data-permission-generation={
        uiActions.latestClipboardObservation?.permissionGeneration ?? clipboard.clipboardSnapshot.permissionGeneration
      }
      data-base-generation={uiActions.latestClipboardObservation?.baseGeneration ?? undefined}
      data-workspace-fallback={
        uiActions.latestClipboardObservation ? String(uiActions.latestClipboardObservation.usedWorkspaceFallback) : undefined
      }
      data-segment-count={uiActions.latestClipboardObservation?.segmentCount ?? undefined}
      data-rectangular={
        uiActions.latestClipboardObservation ? String(uiActions.latestClipboardObservation.rectangular) : undefined
      }
      data-payload-length={uiActions.latestClipboardObservation?.payloadLength ?? undefined}
      data-history-exclusion={uiActions.latestClipboardObservation?.historyExclusion}
      data-payload-revision={uiActions.latestClipboardObservation?.payloadRevision ?? clipboard.clipboardSnapshot.payloadRevision}
      data-caret-count={uiActions.latestClipboardObservation?.caretCount ?? undefined}
      data-observed-at={uiActions.latestClipboardObservation?.observedAt ?? undefined}
      className="sr-only"
    >
      {announcements.clipboardAnnouncement}
    </div>
  </>);
}
