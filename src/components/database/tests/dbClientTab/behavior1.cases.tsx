import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useAppStore } from "../../../../stores/appStore";
import DbClientTab from "../../DbClientTab";
import { dbChildProps, deferred, dialogMock, ipcMock, postgresInfo, streamOk, waitForConnectedEditor, type StreamEvent } from "./harness";

export function registerDbClientTabBehavior1Cases() {

  describe("DbClientTab execution log", () => {
    afterEach(() => {
      cleanup();
      vi.clearAllMocks();
      localStorage.clear();
      dbChildProps.editorInitialDocFallback = "select 1";
    });

    it("logs every statement, switches to the Log after a failure and keeps result sheets", async () => {
      ipcMock.dbConnect.mockResolvedValue({ ok: true });
      dbChildProps.editorInitialDocFallback = "select 1;\nselect missing;\nselect 3";
      ipcMock.dbExecuteStream.mockImplementation(async (_session: string, sql: string, _max: number | null, onEvent: (event: StreamEvent) => void) => {
        if (sql.includes("missing")) throw new Error("1146 (42S02): Table 'missing' doesn't exist");
        streamOk(onEvent);
      });

      render(<DbClientTab tabId="tab-1" info={postgresInfo} visible />);
      await waitForConnectedEditor();
      fireEvent.click(screen.getByTitle("Run (F5)"));

      await waitFor(() => expect(screen.getByTestId("db-execution-log")).toBeInTheDocument());
      expect(screen.getByTestId("result-log-tab")).toHaveAttribute("data-active", "true");
      const entries = screen.getAllByTestId("db-execution-log-entry");
      expect(entries.map((entry) => entry.getAttribute("data-status"))).toEqual(["success", "failed", "not-run"]);
      expect(screen.getAllByTestId("db-execution-log-message")[1]).toHaveTextContent("Table 'missing' doesn't exist");
      expect(screen.getByTestId("db-execution-log-summary")).toHaveTextContent("Success: 1 · Failed: 1 · Not run: 1");
      expect(screen.getAllByTestId("result-sheet-tab")).toHaveLength(2);
      expect(ipcMock.dbAppendHistory).toHaveBeenCalledTimes(2);

      fireEvent.click(screen.getAllByTestId("result-sheet-tab")[0]);
      expect(screen.queryByTestId("db-execution-log")).not.toBeInTheDocument();
      expect(screen.getByTestId("result-log-tab")).toHaveAttribute("data-active", "false");
    });

    it("stays on the last result sheet when every statement succeeds", async () => {
      ipcMock.dbConnect.mockResolvedValue({ ok: true });
      dbChildProps.editorInitialDocFallback = "select 1;\nselect 2";
      ipcMock.dbExecuteStream.mockImplementation(async (_session: string, _sql: string, _max: number | null, onEvent: (event: StreamEvent) => void) => {
        streamOk(onEvent);
      });

      render(<DbClientTab tabId="tab-1" info={postgresInfo} visible />);
      await waitForConnectedEditor();
      fireEvent.click(screen.getByTitle("Run (F5)"));

      await waitFor(() => expect(screen.getAllByTestId("result-sheet-tab")).toHaveLength(2));
      await waitFor(() => expect(screen.getByTestId("result-log-tab")).toHaveAttribute("data-active", "false"));
      fireEvent.click(screen.getByTestId("result-log-tab"));
      expect(screen.getAllByTestId("db-execution-log-entry").map((entry) => entry.getAttribute("data-status"))).toEqual([
        "success",
        "success",
      ]);
      expect(screen.getByTestId("db-execution-log-summary")).toHaveTextContent("Success: 2 · Failed: 0");
    });

    it("keeps the Log open when it is selected while a run is in progress", async () => {
      ipcMock.dbConnect.mockResolvedValue({ ok: true });
      dbChildProps.editorInitialDocFallback = "select 1;\nselect 2";
      const first = deferred<void>();
      ipcMock.dbExecuteStream.mockImplementation(async (_session: string, sql: string, _max: number | null, onEvent: (event: StreamEvent) => void) => {
        if (sql === "select 1") await first.promise;
        streamOk(onEvent);
      });

      render(<DbClientTab tabId="tab-1" info={postgresInfo} visible />);
      await waitForConnectedEditor();
      fireEvent.click(screen.getByTitle("Run (F5)"));
      await waitFor(() => expect(screen.getByTestId("result-log-tab")).toBeInTheDocument());
      fireEvent.click(screen.getByTestId("result-log-tab"));
      await act(async () => first.resolve());

      await waitFor(() => expect(screen.getAllByTestId("result-sheet-tab")).toHaveLength(2));
      await waitFor(() => expect(screen.getByTestId("db-execution-log-summary")).toHaveTextContent("Success: 2"));
      expect(screen.getByTestId("result-log-tab")).toHaveAttribute("data-active", "true");
    });

    it("marks a cancelled statement and the following ones as not run", async () => {
      ipcMock.dbConnect.mockResolvedValue({ ok: true });
      dbChildProps.editorInitialDocFallback = "select sleep(30);\nselect 2";
      const pending = deferred<void>();
      ipcMock.dbExecuteStream.mockImplementation(async () => {
        await pending.promise;
        throw new Error("Query execution was interrupted");
      });

      render(<DbClientTab tabId="tab-1" info={postgresInfo} visible />);
      await waitForConnectedEditor();
      fireEvent.click(screen.getByTitle("Run (F5)"));
      await waitFor(() => expect(screen.getByTitle("Cancel query")).not.toBeDisabled());
      fireEvent.click(screen.getByTitle("Cancel query"));
      await act(async () => pending.resolve());

      await waitFor(() => expect(screen.getByTestId("db-execution-log")).toBeInTheDocument());
      expect(screen.getAllByTestId("db-execution-log-entry").map((entry) => entry.getAttribute("data-status"))).toEqual([
        "cancelled",
        "not-run",
      ]);
      expect(ipcMock.dbCancel).toHaveBeenCalled();
      expect(dialogMock.choice).not.toHaveBeenCalled();
    });
  });

  describe("DbClientTab error choice", () => {
    afterEach(() => {
      cleanup();
      vi.clearAllMocks();
      localStorage.clear();
      dbChildProps.editorInitialDocFallback = "select 1";
    });

    function failWhen(match: (sql: string) => boolean) {
      ipcMock.dbExecuteStream.mockImplementation(async (_session: string, sql: string, _max: number | null, onEvent: (event: StreamEvent) => void) => {
        if (match(sql)) throw new Error(`boom: ${sql}`);
        streamOk(onEvent);
      });
    }

    async function runDoc(doc: string) {
      ipcMock.dbConnect.mockResolvedValue({ ok: true });
      dbChildProps.editorInitialDocFallback = doc;
      render(<DbClientTab tabId="tab-1" info={postgresInfo} visible />);
      await waitForConnectedEditor();
      fireEvent.click(screen.getByTitle("Run (F5)"));
    }

    const statuses = () => screen.getAllByTestId("db-execution-log-entry").map((entry) => entry.getAttribute("data-status"));

    it("asks on a middle failure: Skip continues, Stop halts the rest", async () => {
      failWhen((sql) => sql.startsWith("bad"));
      dialogMock.choice.mockResolvedValueOnce("secondary").mockResolvedValueOnce(null);
      await runDoc("bad 1;\nbad 2;\nselect 3");

      await waitFor(() => expect(dialogMock.choice).toHaveBeenCalledTimes(2));
      expect(dialogMock.choice.mock.calls[0][0]).toMatchObject({ primaryLabel: "Skip all", secondaryLabel: "Skip", cancelLabel: "Stop" });
      const message = dialogMock.choice.mock.calls[0][0].message;
      expect(message).toContain("Statement 1 of 3 failed:\n");
      expect(message).toContain("boom: bad 1");
      await waitFor(() => expect(statuses()).toEqual(["failed", "failed", "not-run"]));
      expect(screen.getAllByTestId("db-execution-log-message")[0]).toHaveTextContent("(skipped, run continued)");
    });

    it("Skip all continues without asking again", async () => {
      failWhen((sql) => sql.startsWith("bad"));
      dialogMock.choice.mockResolvedValueOnce("primary");
      await runDoc("bad 1;\nbad 2;\nselect 3");

      await waitFor(() => expect(statuses()).toEqual(["failed", "failed", "success"]));
      expect(dialogMock.choice).toHaveBeenCalledTimes(1);
      expect(ipcMock.dbExecuteStream).toHaveBeenCalledTimes(3);
    });

    it("confirms dangerous statements and runs nothing when canceled", async () => {
      failWhen(() => false);
      dialogMock.confirm.mockResolvedValueOnce(false);
      await runDoc("select 1;\ndrop table t");

      await waitFor(() => expect(dialogMock.confirm).toHaveBeenCalledTimes(1));
      expect(dialogMock.confirm.mock.calls[0][0]).toMatchObject({ title: "Confirm dangerous statements", danger: true });
      expect(dialogMock.confirm.mock.calls[0][0].message).toContain("[DROP] drop table t");
      await act(async () => undefined);
      expect(ipcMock.dbExecuteStream).not.toHaveBeenCalled();
      expect(screen.queryByTestId("result-log-tab")).not.toBeInTheDocument();
      expect(screen.queryAllByTestId("result-sheet-tab")).toHaveLength(0);
    });

    it("runs the whole script after confirming dangerous statements and skips the prompt for safe runs", async () => {
      failWhen(() => false);
      dialogMock.confirm.mockResolvedValueOnce(true);
      await runDoc("select 1;\ndelete from t");

      await waitFor(() => expect(screen.getAllByTestId("result-sheet-tab")).toHaveLength(2));
      await waitFor(() => expect(ipcMock.dbExecuteStream).toHaveBeenCalledTimes(2));
      fireEvent.click(screen.getByTestId("result-log-tab"));
      await waitFor(() => expect(statuses()).toEqual(["success", "success"]));

      cleanup();
      vi.clearAllMocks();
      await runDoc("select 1;\ndelete from t where id = 1");
      await waitFor(() => expect(ipcMock.dbExecuteStream).toHaveBeenCalledTimes(2));
      expect(dialogMock.confirm).not.toHaveBeenCalled();
    });

    it("explains the statement at the cursor into an Explain sheet", async () => {
      failWhen(() => false);
      ipcMock.dbConnect.mockResolvedValue({ ok: true });
      dbChildProps.editorInitialDocFallback = "select 1;\nselect 2";
      render(<DbClientTab tabId="tab-1" info={postgresInfo} visible />);
      await waitForConnectedEditor();
      fireEvent.click(screen.getByTestId("db-explain-current"));

      await waitFor(() => {
        const calls = ipcMock.dbExecuteStream.mock.calls as Array<[string, string, number, unknown]>;
        expect(calls.map((call) => call[1])).toEqual(["EXPLAIN select 2"]);
      });
      await waitFor(() => expect(screen.getByTestId("result-sheet-tab")).toHaveTextContent("Explain"));
    });

    it("explains why a statement cannot be explained and runs nothing", async () => {
      failWhen(() => false);
      ipcMock.dbConnect.mockResolvedValue({ ok: true });
      dbChildProps.editorInitialDocFallback = "create table t (id int)";
      render(<DbClientTab tabId="tab-1" info={postgresInfo} visible />);
      await waitForConnectedEditor();
      fireEvent.click(screen.getByTestId("db-explain-current"));

      await waitFor(() => expect(dialogMock.alert).toHaveBeenCalledTimes(1));
      expect(dialogMock.alert.mock.calls[0][0].message).toContain("Explain supports");
      expect(ipcMock.dbExecuteStream).not.toHaveBeenCalled();
    });

    it("does not ask when the last statement fails", async () => {
      failWhen((sql) => sql.startsWith("bad"));
      await runDoc("select 1;\nbad 2");

      await waitFor(() => expect(statuses()).toEqual(["success", "failed"]));
      expect(dialogMock.choice).not.toHaveBeenCalled();
    });
  });

  describe("DbClientTab manual commit", () => {
    afterEach(() => {
      cleanup();
      vi.clearAllMocks();
      localStorage.clear();
      dbChildProps.editorInitialDocFallback = "select 1";
    });

    /** Stateful fake of the backend TxState: inserts count while manual. */
    function fakeTx() {
      // `dropNext` simulates the pool opening a new connection before the next statement.
      const state = { supported: true, manual: false, pending: 0, generation: 1, dropNext: false };
      const snapshot = () => ({ supported: state.supported, manual: state.manual, pending: state.pending, generation: state.generation });
      ipcMock.dbTxStatus.mockImplementation(async () => snapshot());
      ipcMock.dbTxSetManual.mockImplementation(async (_sessionId: string, manual: boolean) => {
        state.manual = manual;
        state.pending = 0;
        return snapshot();
      });
      const end = async () => {
        state.pending = 0;
        return snapshot();
      };
      ipcMock.dbTxCommit.mockImplementation(end);
      ipcMock.dbTxRollback.mockImplementation(end);
      ipcMock.dbExecuteStream.mockImplementation(async (_session: string, sql: string, _max: number | null, onEvent: (event: StreamEvent) => void) => {
        if (state.dropNext) {
          state.dropNext = false;
          state.generation += 1;
          state.pending = 0;
        }
        if (state.manual && /^insert/i.test(sql)) state.pending += 1;
        onEvent({ kind: "done", rowsAffected: 1, durationMs: 1, warnings: [] });
      });
      return state;
    }

    async function renderConnected(doc: string) {
      ipcMock.dbConnect.mockResolvedValue({ ok: true });
      dbChildProps.editorInitialDocFallback = doc;
      render(<DbClientTab tabId="tab-1" info={postgresInfo} visible />);
      await waitFor(() => expect(screen.getByTestId("db-tx-mode")).not.toBeDisabled());
    }

    it("switches to manual, counts pending writes and commits or rolls back", async () => {
      fakeTx();
      await renderConnected("insert into t values (1)");
      expect(screen.getByTestId("db-tx-mode")).toHaveTextContent("Auto");
      expect(screen.queryByTestId("db-tx-commit")).not.toBeInTheDocument();

      fireEvent.click(screen.getByTestId("db-tx-mode"));
      await waitFor(() => expect(screen.getByTestId("db-tx-mode")).toHaveAttribute("data-mode", "manual"));
      expect(ipcMock.dbTxSetManual).toHaveBeenCalledWith(expect.any(String), true);
      expect(screen.getByTestId("db-tx-pending")).toHaveTextContent("Pending: 0");

      fireEvent.click(screen.getByTitle("Run (F5)"));
      await waitFor(() => expect(screen.getByTestId("db-tx-pending")).toHaveTextContent("Pending: 1"));
      fireEvent.click(screen.getByTestId("db-tx-commit"));
      await waitFor(() => expect(screen.getByTestId("db-tx-pending")).toHaveTextContent("Pending: 0"));
      expect(ipcMock.dbTxCommit).toHaveBeenCalledTimes(1);

      fireEvent.click(screen.getByTitle("Run (F5)"));
      await waitFor(() => expect(screen.getByTestId("db-tx-pending")).toHaveTextContent("Pending: 1"));
      fireEvent.click(screen.getByTestId("db-tx-rollback"));
      await waitFor(() => expect(screen.getByTestId("db-tx-pending")).toHaveTextContent("Pending: 0"));
      expect(ipcMock.dbTxRollback).toHaveBeenCalledTimes(1);
    });

    it("confirms before switching back to auto-commit with pending statements", async () => {
      fakeTx();
      await renderConnected("insert into t values (1)");
      fireEvent.click(screen.getByTestId("db-tx-mode"));
      await waitFor(() => expect(screen.getByTestId("db-tx-mode")).toHaveAttribute("data-mode", "manual"));
      fireEvent.click(screen.getByTitle("Run (F5)"));
      await waitFor(() => expect(screen.getByTestId("db-tx-pending")).toHaveTextContent("Pending: 1"));

      dialogMock.confirm.mockResolvedValueOnce(false);
      fireEvent.click(screen.getByTestId("db-tx-mode"));
      await waitFor(() => expect(dialogMock.confirm).toHaveBeenCalledTimes(1));
      expect(dialogMock.confirm.mock.calls[0][0]).toMatchObject({
        title: "Switch to auto-commit",
        message: "1 pending statement(s) will be committed.",
      });
      await act(async () => undefined);
      expect(ipcMock.dbTxSetManual).toHaveBeenCalledTimes(1);
      expect(screen.getByTestId("db-tx-mode")).toHaveAttribute("data-mode", "manual");

      dialogMock.confirm.mockResolvedValueOnce(true);
      fireEvent.click(screen.getByTestId("db-tx-mode"));
      await waitFor(() => expect(screen.getByTestId("db-tx-mode")).toHaveAttribute("data-mode", "auto"));
      expect(ipcMock.dbTxSetManual).toHaveBeenLastCalledWith(expect.any(String), false);
      expect(screen.queryByTestId("db-tx-commit")).not.toBeInTheDocument();
    });

    it("warns once when a reconnect drops uncommitted statements", async () => {
      const state = fakeTx();
      await renderConnected("insert into t values (1)");
      fireEvent.click(screen.getByTestId("db-tx-mode"));
      await waitFor(() => expect(screen.getByTestId("db-tx-mode")).toHaveAttribute("data-mode", "manual"));
      fireEvent.click(screen.getByTitle("Run (F5)"));
      await waitFor(() => expect(screen.getByTestId("db-tx-pending")).toHaveTextContent("Pending: 1"));

      state.dropNext = true;
      fireEvent.click(screen.getByTitle("Run (F5)"));
      await waitFor(() => expect(dialogMock.alert).toHaveBeenCalledTimes(1));
      expect(dialogMock.alert.mock.calls[0][0]).toEqual({
        title: "Connection re-established",
        message: "The database connection was re-established. 1 uncommitted statement(s) were lost.",
      });
      // The insert that just ran on the new connection is the only pending one.
      expect(screen.getByTestId("db-tx-pending")).toHaveTextContent("Pending: 1");

      fireEvent.click(screen.getByTestId("db-tx-rollback"));
      await waitFor(() => expect(screen.getByTestId("db-tx-pending")).toHaveTextContent("Pending: 0"));
      state.dropNext = true;
      fireEvent.click(screen.getByTitle("Run (F5)"));
      await waitFor(() => expect(screen.getByTestId("db-tx-pending")).toHaveTextContent("Pending: 1"));
      expect(dialogMock.alert).toHaveBeenCalledTimes(1);
    });

    it("rolls back pending statements before disconnecting when the tab closes", async () => {
      fakeTx();
      await renderConnected("insert into t values (1)");
      fireEvent.click(screen.getByTestId("db-tx-mode"));
      await waitFor(() => expect(screen.getByTestId("db-tx-mode")).toHaveAttribute("data-mode", "manual"));
      fireEvent.click(screen.getByTitle("Run (F5)"));
      await waitFor(() => expect(screen.getByTestId("db-tx-pending")).toHaveTextContent("Pending: 1"));

      // An earlier test's deferred rollback -> disconnect may land late; count from here.
      ipcMock.dbDisconnect.mockClear();
      ipcMock.dbTxRollback.mockClear();
      cleanup();
      await waitFor(() => expect(ipcMock.dbDisconnect).toHaveBeenCalledTimes(1));
      expect(ipcMock.dbTxRollback).toHaveBeenCalledTimes(1);
      expect(ipcMock.dbTxRollback.mock.invocationCallOrder[0]).toBeLessThan(ipcMock.dbDisconnect.mock.invocationCallOrder[0]);
      expect(useAppStore.getState().statusMessage).toBe("Rolled back 1 uncommitted statement(s) when the database tab closed.");
    });

    it("only disconnects on close in auto-commit mode", async () => {
      fakeTx();
      await renderConnected("insert into t values (1)");
      fireEvent.click(screen.getByTitle("Run (F5)"));
      await waitFor(() => expect(ipcMock.dbExecuteStream).toHaveBeenCalledTimes(1));
      // An earlier test's deferred rollback -> disconnect may land late; count from here.
      ipcMock.dbDisconnect.mockClear();
      ipcMock.dbTxRollback.mockClear();
      cleanup();
      await waitFor(() => expect(ipcMock.dbDisconnect).toHaveBeenCalledTimes(1));
      expect(ipcMock.dbTxRollback).not.toHaveBeenCalled();
    });

    it("keeps the toggle disabled until connected and hides it for other engines", async () => {
      fakeTx();
      ipcMock.dbConnect.mockRejectedValueOnce(new Error("offline"));
      render(<DbClientTab tabId="tab-1" info={postgresInfo} visible />);
      await waitFor(() => expect(ipcMock.dbConnect).toHaveBeenCalled());
      expect(screen.getByTestId("db-tx-mode")).toBeDisabled();
      expect(screen.getByTestId("db-tx-mode")).toHaveTextContent("Auto");
      cleanup();

      ipcMock.dbConnect.mockResolvedValue({ ok: true });
      render(<DbClientTab tabId="tab-2" info={{ ...postgresInfo, engine: "ClickHouse" }} visible />);
      await waitForConnectedEditor();
      expect(screen.queryByTestId("db-tx-mode")).not.toBeInTheDocument();
      expect(ipcMock.dbTxStatus).not.toHaveBeenCalled();
    });
  });
}
