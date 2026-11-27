import { useState } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { setLocale } from "../lib/i18n";
import { useUpdateStore } from "../stores/updateStore";
import { UpdateDialog } from "./UpdateDialog";

afterEach(cleanup);

const initialState = useUpdateStore.getState();

describe("UpdateDialog download cancellation", () => {
  beforeEach(() => {
    useUpdateStore.setState({ ...initialState, status: "downloading", dialogOpen: true, progress: { downloaded: 40, total: 100, percent: 40 } });
    setLocale("en");
  });

  it("routes the explicit Cancel control to cancellation, not hiding a live transfer", () => {
    const cancelDownload = vi.fn();
    const closeDialog = vi.fn();
    useUpdateStore.setState({ cancelDownload, closeDialog });
    render(<UpdateDialog />);
    fireEvent.click(screen.getByTestId("update-cancel-download"));
    expect(cancelDownload).toHaveBeenCalledTimes(1);
    expect(closeDialog).not.toHaveBeenCalled();
    expect(screen.getByTestId("update-progress")).toHaveAttribute("aria-valuenow", "40");
  });

  it("does not offer cancellation once verified installation begins", () => {
    useUpdateStore.setState({ status: "installing" });
    render(<UpdateDialog />);
    expect(screen.queryByTestId("update-cancel-download")).not.toBeInTheDocument();
    expect(screen.getByTestId("update-progress")).toHaveTextContent("Installing");
  });
});

describe("UpdateDialog modal & non-modal semantics", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setLocale("en");
  });

  it("mounts modal available prompt on top layer, guards IME Esc, wraps Tab, and restores focus", async () => {
    const closeDialog = vi.fn(() => useUpdateStore.setState({ dialogOpen: false }));
    useUpdateStore.setState({
      ...initialState,
      status: "available",
      dialogOpen: true,
      currentVersion: "0.5.0",
      availableVersion: "0.6.0",
      targetStatus: "ok",
      candidates: [],
      closeDialog,
    });

    function Harness() {
      const [show, setShow] = useState(false);
      return (
        <>
          <button type="button" data-testid="update-opener" onClick={() => setShow(true)}>
            Check
          </button>
          {show && <UpdateDialog />}
        </>
      );
    }

    render(<Harness />);
    const opener = screen.getByTestId("update-opener");
    opener.focus();
    fireEvent.click(opener);

    const dialog = screen.getByTestId("update-dialog");
    expect(dialog).toHaveAttribute("aria-modal", "true");
    const downloadBtn = screen.getByTestId("update-download");
    const laterBtn = screen.getByRole("button", { name: "Later" });
    expect(downloadBtn).toHaveFocus();

    fireEvent.keyDown(dialog, { key: "Tab" });
    expect(laterBtn).toHaveFocus();
    fireEvent.keyDown(dialog, { key: "Tab", shiftKey: true });
    expect(downloadBtn).toHaveFocus();

    fireEvent.keyDown(dialog, { key: "Escape", keyCode: 229 });
    expect(closeDialog).not.toHaveBeenCalled();

    fireEvent.keyDown(dialog, { key: "Escape" });
    expect(closeDialog).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(opener).toHaveFocus());
  });

  it("keeps checking and downloading non-modal and only dismisses checking on Esc", () => {
    const closeDialog = vi.fn();
    useUpdateStore.setState({
      ...initialState,
      status: "checking",
      dialogOpen: true,
      closeDialog,
    });

    const { rerender } = render(<UpdateDialog />);
    const checking = screen.getByTestId("update-dialog");
    expect(checking).not.toHaveAttribute("aria-modal");

    fireEvent.keyDown(window, { key: "Escape", keyCode: 229 });
    expect(closeDialog).not.toHaveBeenCalled();

    fireEvent.keyDown(window, { key: "Escape" });
    expect(closeDialog).toHaveBeenCalledTimes(1);

    closeDialog.mockClear();
    useUpdateStore.setState({
      status: "downloading",
      progress: { downloaded: 10, total: 100, percent: 10 },
    });
    rerender(<UpdateDialog />);
    fireEvent.keyDown(window, { key: "Escape" });
    expect(closeDialog).not.toHaveBeenCalled();
  });
});

describe("UpdateDialog SocksCap recovery authorization", () => {
  const authorizeInstall = vi.fn(async (_password: string) => undefined);
  const cancelAuthorization = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    setLocale("en");
    useUpdateStore.setState({
      ...initialState,
      status: "authorizing",
      dialogOpen: true,
      os: "linux",
      authorizationBusy: false,
      authorizationError: null,
      authorizeInstall,
      cancelAuthorization,
    });
  });

  it("requests sudo in the updater and continues the pending installation", async () => {
    render(<UpdateDialog />);

    expect(screen.getByTestId("sockscap-root-prompt-dialog")).toHaveTextContent(
      "remove residual SocksCap nftables and cgroup state",
    );

    fireEvent.change(screen.getByTestId("sockscap-root-password-input"), {
      target: { value: "root-secret" },
    });
    fireEvent.click(screen.getByTestId("sockscap-root-prompt-submit"));

    await waitFor(() => {
      expect(authorizeInstall).toHaveBeenCalledWith("root-secret");
    });
  });

  it("returns to the update without navigating to SocksCap when authorization is cancelled", () => {
    render(<UpdateDialog />);

    fireEvent.click(screen.getByTestId("sockscap-root-prompt-cancel"));

    expect(cancelAuthorization).toHaveBeenCalledTimes(1);
  });

  it("cancels authorization on Escape without dismissing the update modal", () => {
    const closeDialog = vi.fn();
    useUpdateStore.setState({ closeDialog });
    render(<UpdateDialog />);

    fireEvent.keyDown(screen.getByTestId("sockscap-root-password-input"), { key: "Escape" });
    expect(cancelAuthorization).toHaveBeenCalledTimes(1);
    expect(closeDialog).not.toHaveBeenCalled();
  });
});
