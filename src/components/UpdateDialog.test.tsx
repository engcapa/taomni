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

describe("UpdateDialog SocksCap recovery authorization", () => {
  const authorizeInstall = vi.fn(async (_password: string) => undefined);
  const cancelAuthorization = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    setLocale("en");
    useUpdateStore.setState({
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
});
