import { useEffect, useState, type ComponentPropsWithRef } from "react";
import { WorkspaceObservationBridge } from "./workspaceObservationBridge";

/** Keep per-transaction dev telemetry updates out of the workspace render tree. */
export function WorkspaceObservationBoundary({
  bridge,
  children,
  ...props
}: ComponentPropsWithRef<"div"> & { bridge: WorkspaceObservationBridge }) {
  const [, setRevision] = useState(0);
  useEffect(() => {
    const unsubscribe = bridge.subscribe(() => setRevision((revision) => revision + 1));
    setRevision((revision) => revision + 1);
    return unsubscribe;
  }, [bridge]);
  const workspaceObservation = bridge.getSnapshot();
  return (
    <div
      {...props}
      data-observation-status={workspaceObservation.observationStatus}
      data-observation-revision={workspaceObservation.observationRevision}
      data-observation-fresh={String(workspaceObservation.isFresh)}
    >
        <div
          id="code-workspace-observation"
          data-testid="code-workspace-observation"
          role="status"
          aria-label="Workspace observation status"
          aria-live="polite"
          data-status={workspaceObservation.observationStatus}
          data-source={workspaceObservation.source}
          data-ready={String(workspaceObservation.isFresh)}
          data-revision={workspaceObservation.observationRevision}
          data-observed-at={workspaceObservation.observedAt || undefined}
          data-document-revision-count={workspaceObservation.isFresh
            ? Object.keys(workspaceObservation.documentRevisions).length
            : undefined}
          data-provider-request-count={workspaceObservation.isFresh
            ? Object.values(workspaceObservation.providerRequestCounts).reduce((sum, count) => sum + count, 0)
            : undefined}
          data-provider-cancel-count={workspaceObservation.isFresh
            ? Object.values(workspaceObservation.providerCancelCounts).reduce((sum, count) => sum + count, 0)
            : undefined}
          data-disk-write-count={workspaceObservation.isFresh ? workspaceObservation.diskWriteCount : undefined}
          data-resource-lease-count={workspaceObservation.isFresh ? workspaceObservation.resourceLeaseCount : undefined}
          data-history-receipt-count={workspaceObservation.isFresh ? workspaceObservation.historyReceiptCount : undefined}
          data-clipboard-session-revision={workspaceObservation.isFresh
            ? workspaceObservation.clipboardSessionRevision
            : undefined}
          data-clipboard-consumer-count={workspaceObservation.isFresh
            ? workspaceObservation.clipboardConsumerCount
            : undefined}
          className="sr-only"
        >
          {workspaceObservation.isFresh ? "Workspace observation ready" : "Workspace observation unavailable"}
        </div>
      {children}
    </div>
  );
}
