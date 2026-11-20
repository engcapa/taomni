import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TranslateFn } from "../../lib/i18n";
import type { RunSnapshotRecord } from "../../types";
import type { EntryOutcome } from "../../hooks/useWelcomeSessionResume";
import { RestoreLastSessionRow } from "./RestoreLastSessionRow";
import type { WelcomeRestoreProp } from "./types";

const record: RunSnapshotRecord = {
  schemaVersion: 1,
  revision: 2,
  runSequence: 1,
  batchId: "batch-1",
  committedAtMs: 1000,
  activeIdentity: null,
  entries: [{
    kind: "saved-session",
    identity: "saved:a",
    savedSessionId: "a",
    savedSessionType: "SSH",
    displayName: "session-a",
  }],
};
const success: EntryOutcome = {
  identity: "saved:a",
  kind: "saved-session",
  displayName: "session-a",
  status: "ready",
  readiness: "connected",
  tabId: "tab-a",
  issue: null,
};
const translate = ((key: string) => key) as TranslateFn;

function props(view: WelcomeRestoreProp["view"], outcomes: EntryOutcome[] = []): WelcomeRestoreProp {
  return {
    view,
    outcomes,
    onStartRestore: vi.fn(),
    onRetryFailed: vi.fn(),
    onCancelRestore: vi.fn(),
    onClearRecord: vi.fn(),
  };
}

function available(): WelcomeRestoreProp["view"] {
  return { state: "available", record, legacy: false };
}

function succeeded(): WelcomeRestoreProp["view"] {
  return { state: "succeeded", record, operationId: "restore-1", outcomes: [success] };
}

afterEach(cleanup);

describe("Home snapshot restore banner lifecycle", () => {
  it("keeps progress visible and removes the banner after one successful restore", () => {
    const initial = props(available());
    const { rerender } = render(<RestoreLastSessionRow restore={initial} translate={translate} />);
    fireEvent.click(screen.getByTestId("welcome-restore-last-session"));
    expect(initial.onStartRestore).toHaveBeenCalledOnce();

    rerender(<RestoreLastSessionRow restore={props({
      state: "restoring", record, operationId: "restore-1", completed: 0, total: 1, awaitingEntry: null,
    })} translate={translate} />);
    expect(screen.getByTestId("welcome-restore-status")).toHaveAttribute("data-state", "restoring");
    expect(screen.getByTestId("welcome-restore-last-session")).toBeDisabled();

    rerender(<RestoreLastSessionRow restore={props(succeeded(), [success])} translate={translate} />);
    expect(screen.queryByTestId("welcome-restore-row")).not.toBeInTheDocument();
    expect(screen.queryByTestId("welcome-restore-last-session")).not.toBeInTheDocument();
  });

  it("retains partial failures for retry, then dismisses only after recovery", () => {
    const failure: EntryOutcome = {
      ...success,
      status: "failed",
      readiness: null,
      tabId: null,
      issue: { code: "connect", message: "Connection refused" },
    };
    const partial = props({
      state: "partial", record, operationId: "restore-1", outcomes: [failure],
    }, [failure]);
    const { rerender } = render(<RestoreLastSessionRow restore={partial} translate={translate} />);
    expect(screen.getByTestId("welcome-restore-status")).toHaveAttribute("data-state", "partial");
    expect(screen.getByText(/session-a.*connect/)).toHaveAttribute("title", "Connection refused");
    fireEvent.click(screen.getByTestId("welcome-restore-retry"));
    expect(partial.onRetryFailed).toHaveBeenCalledOnce();

    rerender(<RestoreLastSessionRow restore={props(succeeded(), [success])} translate={translate} />);
    expect(screen.queryByTestId("welcome-restore-row")).not.toBeInTheDocument();
  });

  it("shows the banner again when a different snapshot becomes available", () => {
    const { rerender } = render(<RestoreLastSessionRow restore={props(succeeded(), [success])} translate={translate} />);
    expect(screen.queryByTestId("welcome-restore-row")).not.toBeInTheDocument();

    const nextRecord = { ...record, revision: 3, batchId: "batch-2" };
    rerender(<RestoreLastSessionRow restore={props({ state: "available", record: nextRecord, legacy: false })} translate={translate} />);
    expect(screen.getByTestId("welcome-restore-status")).toHaveAttribute("data-state", "available");
    expect(screen.getByTestId("welcome-restore-last-session")).toBeEnabled();
  });
});
